package com.fathy.alfred.backend.internalcalls.adapter.out.filelog;

import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallBaseline;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
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

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayDeque;
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

    /**
     * How many calls the ring buffer keeps - this slice's only retention mechanism.
     *
     * <p>Deliberately NOT {@code alfred.internal-calls.max-limit}, which is the largest page GET
     * /internal-calls will serve. One property used to do both jobs, which meant the live inbound
     * list could never hold more calls than a single page: raising retention raised the page size
     * and vice versa, and inbound traffic silently evicted calls that were still recent. Confirmed
     * live - a call logged 90 minutes earlier had already been pushed out by newer traffic while
     * the list still claimed to be showing everything.
     *
     * <p>A new call costs one appended line, not a rewrite of the whole file (see {@link #save}),
     * so this no longer scales the per-call write cost - only how much the periodic compaction has
     * to stream, and how much of the file a cold read parses. Raising it into five figures still
     * wants a real store rather than a bigger flat file, but for a different reason now: read and
     * filter cost, not write amplification.
     */
    @Value("${alfred.internal-calls.retention-rows:1500}")
    private int retentionRows;

    /**
     * How many lines the file is actually allowed to hold before {@link #save} compacts it back
     * down to {@link #retentionRows}. The slack is what makes appending viable: without it, every
     * call past the cap would have to rewrite the file to drop one old line, which is exactly the
     * behaviour this replaced.
     *
     * <p>Half the retention (floored at 50 for very small caps) amortises one rewrite over that
     * many calls - at the default 1500 that is one compaction per 750 calls instead of one rewrite
     * per call. The cost is that the file can sit up to 50% larger than the cap on disk; reads are
     * unaffected, since {@link #loadLines} only ever serves the newest {@code retentionRows}.
     */
    private int compactionThreshold() {
        return retentionRows + Math.max(retentionRows / 2, 50);
    }

    /**
     * Lines currently on disk, which is NOT {@code cachedLines.size()} - between compactions the
     * file legitimately holds more than {@link #retentionRows} while the cache serves only the
     * newest ones. -1 when unknown (nothing read yet, or the cache was invalidated); every write
     * path calls {@link #loadLines} first, so it is always populated by the time it is read.
     */
    private int linesOnDisk = -1;

    /** Per-call cap on retained WebSocket messages - mirrors backend-calls' own property. */
    @Value("${alfred.internal-calls.ws-max-messages:1000}")
    private int wsMaxMessages;

    /**
     * WebSocket messages, kept in memory only - never written to internal-calls.log or a sibling
     * file. Consistent with this slice's own design, not a shortcut: it has no SQLite adapter and
     * already keeps its whole retained window resident in memory (see docs/architecture.md on why
     * backend's mem_limit is 2g), so messages for calls the ring still retains living in memory
     * too costs nothing this slice doesn't already pay. Pruned in {@link #save} whenever the ring
     * evicts a call, so this map's size stays bounded by retentionRows * wsMaxMessages the same
     * way the ring itself is bounded.
     */
    private final Map<String, List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage>> wsMessagesByCallId =
            new ConcurrentHashMap<>();
    private final Map<String, Integer> wsDroppedByCallId = new ConcurrentHashMap<>();

    private void pruneWsMessages(List<CachedLine> retained) {
        if (wsMessagesByCallId.isEmpty()) {
            return;
        }
        var retainedIds = retained.stream().map(line -> line.record() != null ? line.record().id() : null)
                .filter(java.util.Objects::nonNull)
                .collect(java.util.stream.Collectors.toSet());
        wsMessagesByCallId.keySet().removeIf(id -> !retainedIds.contains(id));
        wsDroppedByCallId.keySet().removeIf(id -> !retainedIds.contains(id));
    }

    /**
     * A retained call. {@code record} is null when the line did not parse; that line still occupies
     * a slot in the ring, and {@link #readAll()} keeps skipping it.
     *
     * <p>The raw line is deliberately not kept here. It is a second copy of the same request and
     * response bodies the record already holds, and with {@code retention-rows} in the thousands
     * that copy alone filled the heap — a later read of any other multi-megabyte column then failed
     * with OutOfMemoryError. Compaction copies the retained line bytes from the file instead.
     */
    private record CachedLine(CallRecord record) {}

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
     * internal-calls.log is a ring buffer, not an unbounded append log: reads only ever see the
     * newest {@link #retentionRows} calls. Synchronized so concurrent webhook calls can't
     * interleave their read-modify-write and lose an entry.
     *
     * <p><strong>Appends one line; rewrites the file only on compaction.</strong> This used to
     * rebuild the entire file in memory on every single call - {@code StringBuilder} over every
     * retained line, then {@code toString()}, then encode to bytes - which at the default 1500-row
     * cap and a real ~33 KB call is on the order of 150-250 MB of transient allocation to record
     * ONE call, against a 256 MB heap. Under concurrent inbound traffic the backend OOMed and
     * dropped calls silently: the proxy delivered every webhook (no client-side failure to log),
     * the handler threw {@code OutOfMemoryError}, and the call was simply never persisted.
     * Measured on this adapter before the change: 60 concurrent inbound calls produced 504
     * {@code OutOfMemoryError}s and only 4 of the 60 were stored.
     *
     * <p>Appending costs one call's own bytes regardless of how big the file is, so the per-call
     * cost is now flat instead of growing with the retention cap.
     */
    private synchronized void save(CallRecord call) {
        Path path = Path.of(internalCallsFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }

            List<CachedLine> retained = loadLines();
            String addedText = objectMapper.writeValueAsString(call);
            CachedLine added = new CachedLine(call);

            // The cache always holds the retained VIEW (newest retentionRows), even while the file
            // on disk legitimately holds more - that gap is what the slack buys.
            List<CachedLine> next = new ArrayList<>(retained.size() + 1);
            next.addAll(retained);
            next.add(added);
            if (next.size() > retentionRows) {
                next = new ArrayList<>(next.subList(next.size() - retentionRows, next.size()));
                pruneWsMessages(next);
            }

            if (linesOnDisk + 1 > compactionThreshold()) {
                // Every entry but the one just added is already the file's newest lines.
                linesOnDisk = writeCompacted(path, next.size() - 1, addedText);
            } else {
                Files.writeString(path, addedText + System.lineSeparator(),
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.WRITE);
                linesOnDisk++;
            }

            rememberCache(path, next);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to save to {}: {}", internalCallsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Replaces {@code path} with its newest {@code linesFromFile} non-empty lines, byte for byte,
     * then appends {@code newCallJson} when it is non-null. Returns how many lines the file has
     * afterwards.
     *
     * <p>Only the line offsets are held (a few bytes each). The line bodies stay on disk and are
     * copied through a small buffer, so compaction does not pull the retained window into the heap
     * a second time. A crash mid-write leaves the previous file intact.
     */
    private int writeCompacted(Path path, int linesFromFile, String newCallJson) throws IOException {
        List<LineSpan> spans = lastNonEmptySpans(path, linesFromFile);
        Path temp = path.resolveSibling(path.getFileName() + ".compacting");
        byte[] newline = System.lineSeparator().getBytes(StandardCharsets.UTF_8);
        try (SeekableByteChannel src = Files.newByteChannel(path, StandardOpenOption.READ);
             OutputStream out = Files.newOutputStream(temp, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            byte[] buf = new byte[8192];
            for (LineSpan span : spans) {
                src.position(span.start());
                long left = span.length();
                while (left > 0) {
                    int n = src.read(ByteBuffer.wrap(buf, 0, (int) Math.min(buf.length, left)));
                    if (n < 0) {
                        break;
                    }
                    out.write(buf, 0, n);
                    left -= n;
                }
                out.write(newline);
            }
            if (newCallJson != null) {
                out.write(newCallJson.getBytes(StandardCharsets.UTF_8));
                out.write(newline);
            }
        }
        moveIntoPlace(temp, path);
        return spans.size() + (newCallJson == null ? 0 : 1);
    }

    /** Byte range of one line's content, excluding its terminator. */
    private record LineSpan(long start, int length) {}

    /**
     * Offsets of the last {@code keep} non-empty lines, oldest first. A line is empty when it has
     * no byte above ASCII space, which is the log-file equivalent of {@code String.strip().isEmpty()}.
     * The terminator ({@code \n} or {@code \r\n}) is not part of the range, matching {@code readLine}.
     */
    private static List<LineSpan> lastNonEmptySpans(Path path, int keep) throws IOException {
        if (keep <= 0 || !Files.exists(path)) {
            return List.of();
        }
        LineSpan[] ring = new LineSpan[keep];
        int cursor = 0;
        int filled = 0;
        try (InputStream in = Files.newInputStream(path)) {
            byte[] buf = new byte[8192];
            long pos = 0;
            long lineStart = 0;
            boolean nonWhitespace = false;
            int prev = -1;
            int read;
            while ((read = in.read(buf)) != -1) {
                for (int i = 0; i < read; i++) {
                    int b = buf[i] & 0xff;
                    long at = pos + i;
                    if (b == '\n') {
                        long end = prev == '\r' ? at - 1 : at;
                        if (nonWhitespace && end > lineStart) {
                            ring[cursor] = new LineSpan(lineStart, (int) (end - lineStart));
                            cursor = (cursor + 1) % keep;
                            if (filled < keep) {
                                filled++;
                            }
                        }
                        lineStart = at + 1;
                        nonWhitespace = false;
                    } else if (b != '\r' && b > ' ') {
                        nonWhitespace = true;
                    }
                    prev = b;
                }
                pos += read;
            }
            if (lineStart < pos) {
                long end = prev == '\r' ? pos - 1 : pos;
                if (nonWhitespace && end > lineStart) {
                    ring[cursor] = new LineSpan(lineStart, (int) (end - lineStart));
                    cursor = (cursor + 1) % keep;
                    if (filled < keep) {
                        filled++;
                    }
                }
            }
        }
        List<LineSpan> spans = new ArrayList<>(filled);
        int start = filled < keep ? 0 : cursor;
        for (int i = 0; i < filled; i++) {
            spans.add(ring[(start + i) % keep]);
        }
        return spans;
    }

    private static void moveIntoPlace(Path temp, Path path) throws IOException {
        try {
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** Holds the partial call in memory only - nothing is written to internal-calls.log until {@link #complete} - see the class-level doc on {@link #pendingById}. */
    @Override
    public void prepare(CallRecord call) {
        pendingById.put(call.id(), call);
    }

    /** Merges the outcome into the pending call (if this process is still the one that prepared it) and performs the one, single-shot disk write. */
    @Override
    public synchronized boolean complete(String id, ResponseData response, String error, Double durationMs,
                                         CallInterception interception, Boolean reachedUpstream) {
        CallRecord partial = pendingById.remove(id);
        boolean wasPending = partial != null;
        boolean hasError = error != null && !error.isBlank();
        CallLifecycleStatus state = hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED;
        CallRecord resolved = partial != null
                // Uses the full 13-arg constructor (unlike backend-calls' FileCallLogAdapter,
                // which drops sessionId/operationId here via its 10-arg constructor - harmless
                // there since SQLite is that slice's primary adapter, but this file adapter is
                // this slice's *only* store, so losing session/operation id (or now serviceName)
                // at completion time would silently break the session-id/operation-id/source
                // filters for every completed call). relive is known at prepare time (research
                // D2.3), so it comes from partial, not this completion payload.
                ? new CallRecord(partial.id(), partial.originalUrl(), partial.url(), partial.method(), partial.request(),
                        partial.timestamp(), durationMs, response, error, state, partial.sessionId(), partial.operationId(), partial.serviceName(),
                        null, partial.resendOf(), partial.resendEdits(), partial.relive(), reachedUpstream)
                // Degraded fallback: this process never saw the matching prepare() (e.g. restarted
                // in between) - persist what the completion payload alone can offer rather than
                // silently dropping it. serviceName/relive unknown too in this narrow, accepted-gap case.
                : new CallRecord(id, null, null, null, null, null, durationMs, response, error, state, null, null, null,
                        null, null, null, null, reachedUpstream);
        save(resolved.withInterception(interception));
        return wasPending;
    }

    /** Returns the cached lines, re-reading and re-parsing only when the file's size/mtime no longer match what was cached. */
    private List<CachedLine> loadLines() {
        Path path = Path.of(internalCallsFile);
        if (!Files.exists(path)) {
            cachedLines = List.of();
            cachedFileSize = -1;
            cachedModifiedMillis = -1;
            linesOnDisk = 0;
            return cachedLines;
        }

        BasicFileAttributes attributes = readAttributes(path);
        if (cachedLines != null && attributes != null
                && attributes.size() == cachedFileSize
                && attributes.lastModifiedTime().toMillis() == cachedModifiedMillis) {
            return cachedLines;
        }

        Scan scan;
        try {
            scan = scanFile(path);
            if (scan.needsBackfill()) {
                rewriteMissingIds(path);
                scan = scanFile(path);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read " + path, e);
        }
        // Every non-empty line the file holds, not just the retained view - this is what decides
        // when the next save has to compact.
        linesOnDisk = scan.lineCount();
        rememberCache(path, scan.retained());
        return cachedLines != null ? cachedLines : List.copyOf(scan.retained());
    }

    private record Scan(int lineCount, boolean needsBackfill, List<CachedLine> retained) {}

    /**
     * One pass over the file. The ring keeps only the newest {@link #retentionRows} parsed lines,
     * and each of those drops the raw JSON as soon as it has been parsed, so a cold read of a
     * file that is larger than the heap never has to hold both copies at once.
     */
    private Scan scanFile(Path path) throws IOException {
        ArrayDeque<CachedLine> ring = new ArrayDeque<>();
        int count = 0;
        boolean needsBackfill = false;
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                String trimmed = rawLine.strip();
                if (trimmed.isEmpty()) {
                    continue;
                }
                count++;
                CallRecord record = null;
                try {
                    record = objectMapper.readValue(trimmed, CallRecord.class);
                    if (record.id() == null) {
                        needsBackfill = true;
                    }
                } catch (IOException e) {
                    log.warn("Skipping malformed line in {}: {}", path, e.getMessage());
                }
                ring.addLast(new CachedLine(record));
                while (ring.size() > retentionRows) {
                    ring.removeFirst();
                }
            }
        }
        return new Scan(count, needsBackfill, new ArrayList<>(ring));
    }

    /**
     * Rewrites the whole file so every line that parsed without an id gets one, one line at a time.
     * Lines that already have an id are copied back unchanged. Same durability as compaction: a
     * temp file is moved into place only after the rewrite finishes.
     */
    private void rewriteMissingIds(Path path) throws IOException {
        Path temp = path.resolveSibling(path.getFileName() + ".compacting");
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8);
             BufferedWriter writer = Files.newBufferedWriter(temp, StandardCharsets.UTF_8,
                     StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                String trimmed = rawLine.strip();
                if (trimmed.isEmpty()) {
                    continue;
                }
                String written = rawLine;
                try {
                    CallRecord record = objectMapper.readValue(trimmed, CallRecord.class);
                    if (record.id() == null) {
                        written = objectMapper.writeValueAsString(withGeneratedId(record));
                    }
                } catch (IOException e) {
                    log.warn("Skipping malformed line in {}: {}", path, e.getMessage());
                }
                writer.write(written);
                writer.newLine();
            }
        }
        moveIntoPlace(temp, path);
    }

    /**
     * Filters/sorts/paginates over the full in-memory list, applying the sessionId/operationId/
     * requestId substring filters and the serviceNames exact-match filter first, since
     * CallListSupport here has no built-in id-filter overload (only backend-calls' SQL repository
     * has that) - then maps to CallSummary as the final step, matching CallLogPort's summary-only
     * contract.
     */
    @Override
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                                     String sessionId, String operationId, String requestId, String serviceNames) {
        java.util.Set<String> serviceNameFilter = parseServiceNames(serviceNames);
        List<CallRecord> idFiltered = readAll().stream()
                .filter(call -> matchesSubstring(call.sessionId(), sessionId))
                .filter(call -> matchesSubstring(call.operationId(), operationId))
                .filter(call -> matchesSubstring(call.id(), requestId))
                .filter(call -> matchesServiceNames(call, serviceNameFilter))
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

    /** Comma-separated project names (see CallsQuery.serviceNames) into a set - blank/empty input means "no filter", represented as an empty set rather than null so callers never need a separate null check. */
    private static java.util.Set<String> parseServiceNames(String serviceNames) {
        if (serviceNames == null || serviceNames.isBlank()) {
            return java.util.Set.of();
        }
        java.util.Set<String> names = new java.util.HashSet<>();
        for (String name : serviceNames.split(",")) {
            String trimmed = name.strip();
            if (!trimmed.isEmpty()) {
                names.add(trimmed);
            }
        }
        return names;
    }

    /** An empty filter set matches everything (no filter applied). A null serviceName (a call logged before this field existed) is treated as LoggingToggleService.UNKNOWN_NAME, same as every other read path. */
    private static boolean matchesServiceNames(CallRecord call, java.util.Set<String> filter) {
        if (filter.isEmpty()) {
            return true;
        }
        String name = call.serviceName() != null ? call.serviceName() : com.fathy.alfred.backend.internalcalls.application.service.LoggingToggleService.UNKNOWN_NAME;
        return filter.contains(name);
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
        linesOnDisk = -1;
    }

    private BasicFileAttributes readAttributes(Path path) {
        try {
            return Files.readAttributes(path, BasicFileAttributes.class);
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * Percentiles over the in-memory cache this adapter already keeps. The file is ring-buffered at
     * alfred.internal-calls.max-limit, so this is a baseline over recent traffic rather than all of
     * history - sorting a few hundred doubles is cheap, and there is no index here to lean on.
     */
    @Override
    public CallBaseline baselineFor(String url) {
        List<Double> durations = readAll().stream()
                .filter(call -> url.equals(call.url()))
                .filter(call -> call.state() != CallLifecycleStatus.IN_PROGRESS && call.durationMs() != null)
                .map(CallRecord::durationMs)
                .sorted()
                .toList();
        if (durations.isEmpty()) {
            return CallBaseline.empty(url);
        }
        return new CallBaseline(url, durations.size(), at(durations, 0.50), at(durations, 0.95));
    }

    private static Double at(List<Double> sorted, double percentile) {
        int index = Math.min(sorted.size() - 1, Math.max(0, (int) Math.floor(sorted.size() * percentile)));
        return sorted.get(index);
    }

    @Override
    public void appendWsMessages(String callId, List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> messages,
                                  boolean closed, Integer closeCode) {
        if (messages.isEmpty()) {
            return;
        }
        List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> existing =
                wsMessagesByCallId.computeIfAbsent(callId, id -> Collections.synchronizedList(new ArrayList<>()));
        synchronized (existing) {
            existing.addAll(messages);
            int overflow = existing.size() - wsMaxMessages;
            if (overflow > 0) {
                existing.subList(0, overflow).clear();
                wsDroppedByCallId.merge(callId, overflow, Integer::sum);
            }
        }
    }

    @Override
    public com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage wsMessages(String callId, int offset, int limit) {
        List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> all = wsMessagesByCallId.getOrDefault(callId, List.of());
        List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> page;
        int total;
        synchronized (all) {
            total = all.size();
            page = all.stream().skip(Math.max(0, offset)).limit(Math.max(0, limit)).toList();
        }
        return new com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage(
                page, total, wsDroppedByCallId.getOrDefault(callId, 0));
    }
}
