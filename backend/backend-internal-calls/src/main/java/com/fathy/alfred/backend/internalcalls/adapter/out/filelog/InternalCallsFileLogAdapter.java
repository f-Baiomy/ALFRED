package com.fathy.alfred.backend.internalcalls.adapter.out.filelog;

import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Owns internal-calls.log end to end - the only place in this slice that knows calls live in a
 * flat file. Unlike backend-calls, this slice has only ever had one storage adapter (no
 * SQLite/file @ConditionalOnProperty switch), so this is a plain @Component - the ring-buffer cap
 * ({@code alfred.internal-calls.max-limit}) is this slice's only retention mechanism.
 *
 * <p>Mirrors FileCallLogAdapter's exact caching idiom: reads are served from an in-memory cache
 * rather than re-parsing the file on every request, validated against the file's size and
 * last-modified-time on every read so a file modified or replaced out-of-band is re-read rather
 * than silently ignored. Per-instance, never static.
 */
@Component
public class InternalCallsFileLogAdapter implements CallLogPort {

    private static final Logger log = LoggerFactory.getLogger(InternalCallsFileLogAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${INTERNAL_CALLS_FILE:/appdata/internal-calls.log}")
    private String internalCallsFile;

    /** Same property InternalCallsService clamps GET /internal-calls with - kept in sync by construction since both read the one property. */
    @Value("${alfred.internal-calls.max-limit:200}")
    private int maxLimit;

    /**
     * One line of the file together with its parsed form ({@code null} when that line failed to
     * parse). Caching both keeps save able to rewrite the file from the original line text,
     * preserving the existing behaviour exactly: a malformed line stays on disk and still counts
     * toward the ring buffer's size, while {@link #readAll()} keeps skipping it.
     */
    private record CachedLine(String text, CallRecord record) {}

    /** Null until the first read/write populates it. Replaced wholesale, never mutated in place. */
    private List<CachedLine> cachedLines;
    private long cachedFileSize = -1;
    private long cachedModifiedMillis = -1;

    /**
     * Holds a {@link #prepare}d call here in memory until {@link #complete} merges in the outcome
     * and only then writes it to disk exactly once. If the process restarts between prepare and
     * complete, the pending entry is lost and complete() degrades to persisting whatever the
     * completion payload alone can produce (no request-side data) - the same accepted gap
     * backend-calls' FileCallLogAdapter takes for the same scenario.
     */
    private final Map<String, CallRecord> pendingById = new ConcurrentHashMap<>();

    /** Fail fast with a clear message if the directory isn't writable, rather than only discovering it on the first webhook call. */
    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(internalCallsFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Internal-calls directory {} is not writable - saving new calls will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create internal-calls directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public synchronized List<CallRecord> readAll() {
        List<CachedLine> lines = loadLines();
        List<CallRecord> calls = new ArrayList<>(lines.size());
        for (CachedLine line : lines) {
            if (line.record() != null) {
                calls.add(line.record());
            }
        }
        return Collections.unmodifiableList(calls);
    }

    /**
     * internal-calls.log is a ring buffer, not an unbounded append log: once it holds maxLimit
     * calls, adding one more drops the oldest line first. Synchronized so concurrent webhook calls
     * can't interleave their read-modify-write and lose an entry.
     */
    private synchronized void save(CallRecord call) {
        Path path = Path.of(internalCallsFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }

            List<CachedLine> next = new ArrayList<>(loadLines());
            next.add(new CachedLine(objectMapper.writeValueAsString(call), call));
            if (next.size() > maxLimit) {
                next = new ArrayList<>(next.subList(next.size() - maxLimit, next.size()));
            }

            StringBuilder content = new StringBuilder();
            for (CachedLine line : next) {
                content.append(line.text()).append(System.lineSeparator());
            }
            Files.writeString(path, content.toString(), StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);

            rememberCache(path, next);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to save to {}: {}", internalCallsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Holds the partial call in memory only - nothing is written to internal-calls.log until {@link #complete} - see the class-level doc on {@link #pendingById}. */
    @Override
    public void prepare(CallRecord call) {
        pendingById.put(call.id(), call);
    }

    /** Merges the outcome into the pending call (if this process is still the one that prepared it) and performs the one, single-shot disk write. */
    @Override
    public synchronized boolean complete(String id, ResponseData response, String error, Double durationMs) {
        CallRecord partial = pendingById.remove(id);
        boolean wasPending = partial != null;
        boolean hasError = error != null && !error.isBlank();
        CallLifecycleStatus state = hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED;
        CallRecord resolved = partial != null
                // Uses the full 12-arg constructor (unlike backend-calls' FileCallLogAdapter,
                // which drops sessionId/operationId here via its 10-arg constructor - harmless
                // there since SQLite is that slice's primary adapter, but this file adapter is
                // this slice's *only* store, so losing session/operation id at completion time
                // would silently break the session-id/operation-id filters for every completed call).
                ? new CallRecord(partial.id(), partial.originalUrl(), partial.url(), partial.method(), partial.request(),
                        partial.timestamp(), durationMs, response, error, state, partial.sessionId(), partial.operationId())
                // Degraded fallback: this process never saw the matching prepare() (e.g. restarted
                // in between) - persist what the completion payload alone can offer rather than
                // silently dropping it.
                : new CallRecord(id, null, null, null, null, null, durationMs, response, error, state, null, null);
        save(resolved);
        return wasPending;
    }

    /** Returns the cached lines, re-reading and re-parsing only when the file's size/mtime no longer match what was cached. */
    private List<CachedLine> loadLines() {
        Path path = Path.of(internalCallsFile);
        if (!Files.exists(path)) {
            cachedLines = List.of();
            cachedFileSize = -1;
            cachedModifiedMillis = -1;
            return cachedLines;
        }

        BasicFileAttributes attributes = readAttributes(path);
        if (cachedLines != null && attributes != null
                && attributes.size() == cachedFileSize
                && attributes.lastModifiedTime().toMillis() == cachedModifiedMillis) {
            return cachedLines;
        }

        List<String> rawLines;
        try {
            rawLines = Files.readAllLines(path);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read " + path, e);
        }

        List<CachedLine> parsed = new ArrayList<>(rawLines.size());
        boolean needsBackfill = false;
        for (String rawLine : rawLines) {
            String trimmed = rawLine.strip();
            if (trimmed.isEmpty()) {
                continue;
            }
            CallRecord record = null;
            try {
                record = objectMapper.readValue(trimmed, CallRecord.class);
                if (record.id() == null) {
                    // Written before CallRecord had an id, or malformed upstream - backfilled once
                    // here rather than left to regenerate a different id on every read.
                    record = withGeneratedId(record);
                    trimmed = objectMapper.writeValueAsString(record);
                    needsBackfill = true;
                }
            } catch (IOException e) {
                log.warn("Skipping malformed line in {}: {}", path, e.getMessage());
            }
            parsed.add(new CachedLine(trimmed, record));
        }

        if (needsBackfill) {
            persistBackfilledLines(path, parsed);
        } else {
            rememberCache(path, parsed);
        }
        return cachedLines != null ? cachedLines : List.copyOf(parsed);
    }

    /** Rewrites the whole file with backfilled ids in place - the same shape as save's write, just triggered by a read that found missing ids instead of a new call arriving. */
    private void persistBackfilledLines(Path path, List<CachedLine> lines) {
        try {
            StringBuilder content = new StringBuilder();
            for (CachedLine line : lines) {
                content.append(line.text()).append(System.lineSeparator());
            }
            Files.writeString(path, content.toString(), StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            rememberCache(path, lines);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to persist backfilled ids to {}: {}", internalCallsFile, e.getMessage());
        }
    }

    /**
     * Filters/sorts/paginates over the full in-memory list, applying the sessionId/operationId/
     * requestId substring filters first (case-insensitive contains) since CallListSupport here has
     * no built-in id-filter overload (only backend-calls' SQL repository has that) - then maps to
     * CallSummary as the final step, matching CallLogPort's summary-only contract.
     */
    @Override
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                                     String sessionId, String operationId, String requestId) {
        List<CallRecord> idFiltered = readAll().stream()
                .filter(call -> matchesSubstring(call.sessionId(), sessionId))
                .filter(call -> matchesSubstring(call.operationId(), operationId))
                .filter(call -> matchesSubstring(call.id(), requestId))
                .toList();
        CallListSupport.Page<CallRecord> page = CallListSupport.apply(
                idFiltered, java.util.function.Function.identity(), search, supplier, sort, offset, limit, paginationEnabled);
        return new CallListSupport.Page<>(page.items().stream().map(CallSummary::of).toList(), page.total());
    }

    private static boolean matchesSubstring(String value, String filter) {
        if (filter == null || filter.isBlank()) {
            return true;
        }
        return value != null && value.toLowerCase(java.util.Locale.ROOT).contains(filter.toLowerCase(java.util.Locale.ROOT));
    }

    @Override
    public Optional<CallRecord> findById(String id) {
        return readAll().stream().filter(call -> id.equals(call.id())).findFirst();
    }

    @Override
    public synchronized long storageSizeBytes() {
        try {
            return Files.size(Path.of(internalCallsFile));
        } catch (IOException e) {
            return 0L;
        }
    }

    /** Loads the whole (ring-buffer-capped) list to count buckets - fine at this adapter's scale. */
    @Override
    public synchronized CallStatusBreakdown statusBreakdown() {
        long ok = 0, clientError = 0, serverError = 0;
        List<CallRecord> calls = readAll();
        for (CallRecord call : calls) {
            boolean hasError = call.error() != null && !call.error().isBlank();
            Integer status = call.response() != null ? call.response().status() : null;
            if (hasError || (status != null && status >= 500)) {
                serverError++;
            } else if (status != null && status >= 400) {
                clientError++;
            } else if (status != null && status >= 200) {
                ok++;
            }
        }
        // Always 0 - this adapter never persists an in-progress call to disk (see pendingById's
        // doc), so there's nothing on-disk to count into this bucket.
        return new CallStatusBreakdown(calls.size(), ok, clientError, serverError, 0);
    }

    @Override
    public synchronized void deleteAll() {
        Path path = Path.of(internalCallsFile);
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            log.error("Failed to delete {}: {}", internalCallsFile, e.getMessage());
        }
        invalidateCache();
        pendingById.clear();
    }

    private static CallRecord withGeneratedId(CallRecord call) {
        return new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(), call.method(),
                call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }

    /** Stores {@code lines} as the cache, stamped with the file's current size/mtime - or invalidates instead if the file can't be stat'd, so the next read re-parses rather than trusting an unverifiable snapshot. */
    private void rememberCache(Path path, List<CachedLine> lines) {
        BasicFileAttributes attributes = readAttributes(path);
        if (attributes == null) {
            invalidateCache();
            return;
        }
        cachedLines = List.copyOf(lines);
        cachedFileSize = attributes.size();
        cachedModifiedMillis = attributes.lastModifiedTime().toMillis();
    }

    private void invalidateCache() {
        cachedLines = null;
        cachedFileSize = -1;
        cachedModifiedMillis = -1;
    }

    private BasicFileAttributes readAttributes(Path path) {
        try {
            return Files.readAttributes(path, BasicFileAttributes.class);
        } catch (IOException e) {
            return null;
        }
    }
}
