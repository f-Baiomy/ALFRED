package com.fathy.alfred.backend.calls.adapter.out.filelog;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
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
import java.util.UUID;

/**
 * Owns RECENT_CALLS.log end to end - the proxy only calls the webhook now, it no longer writes
 * any file itself; this is the only place in the app that knows calls live in a flat file -
 * swapping to a different storage (Redis, MySQL, ...) later means writing a new CallLogPort
 * implementation with its own {@code havingValue}, not touching CallsService or anything
 * upstream of the port. {@code matchIfMissing = true} keeps this the default so existing
 * deployments (no {@code alfred.storage.calls.type} set) behave exactly as before.
 *
 * <p><b>Reads are served from an in-memory cache rather than re-parsing the file.</b> Every
 * {@code GET /calls} used to re-read and re-Jackson-parse the whole file (up to
 * {@code alfred.calls.max-limit} records, each carrying full request/response bodies), and every
 * open dashboard tab polls that endpoint on a 5s timer - so the same parse repeated forever even
 * when nothing had changed. This adapter is the sole writer of the file (see CLAUDE.md), so it
 * keeps the parsed result in memory and updates it in place on each save. The cache is still
 * validated against the file's size and last-modified-time on every read, so a file modified or
 * replaced out-of-band (a manual edit, a restored volume) is re-read rather than silently
 * ignored - the guarantee is "never serve stale data", not "trust memory blindly". Per-instance,
 * never static, so a fresh adapter pointed at an existing file always reads it first.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.calls", name = "type", havingValue = "file", matchIfMissing = true)
public class FileCallLogAdapter implements CallLogPort {

    private static final Logger log = LoggerFactory.getLogger(FileCallLogAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${RECENT_CALLS_FILE:/appdata/RECENT_CALLS.log}")
    private String recentCallsFile;

    /** Same property CallsService clamps GET /calls with - kept in sync by construction since both read the one property. */
    @Value("${alfred.calls.max-limit:200}")
    private int maxLimit;

    /**
     * One line of the file together with its parsed form ({@code null} when that line failed to
     * parse). Caching both keeps save() able to rewrite the file from the original line text,
     * preserving the existing behaviour exactly: a malformed line stays on disk and still counts
     * toward the ring buffer's size, while {@link #readAll()} keeps skipping it.
     */
    private record CachedLine(String text, CallRecord record) {}

    /** Null until the first read/write populates it. Replaced wholesale, never mutated in place. */
    private List<CachedLine> cachedLines;
    private long cachedFileSize = -1;
    private long cachedModifiedMillis = -1;

    /** Fail fast with a clear message if the directory isn't writable, rather than only discovering it on the first webhook call. */
    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(recentCallsFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Recent-calls directory {} is not writable - saving new calls will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create recent-calls directory {}: {}", parent, e.getMessage());
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
     * RECENT_CALLS.log is a ring buffer, not an unbounded append log: once it holds maxLimit
     * calls, adding one more drops the oldest line first. That still rewrites the whole file -
     * fine at maxLimit's scale (default 200) - but it no longer re-reads and re-parses it first:
     * the cache already holds every existing line, so a save costs one serialization (of the new
     * call) plus the write. Synchronized so concurrent webhook calls can't interleave their
     * read-modify-write and lose an entry.
     */
    @Override
    public synchronized void save(CallRecord call) {
        Path path = Path.of(recentCallsFile);
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
            log.error("Failed to save to {}: {}", recentCallsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Returns the cached lines, re-reading and re-parsing only when the file's size/mtime no longer match what was cached. */
    private List<CachedLine> loadLines() {
        Path path = Path.of(recentCallsFile);
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
                    // Written before CallRecord had an id - backfilled once here rather than left
                    // to regenerate a different id on every read, which would make comments'
                    // migration to real call ids (see the one-time startup migration in
                    // backend-app) permanently unable to keep matching this call.
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

    /** Rewrites the whole file with backfilled ids in place - the same shape as save()'s write, just triggered by a read that found missing ids instead of a new call arriving. */
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
            log.error("Failed to persist backfilled ids to {}: {}", recentCallsFile, e.getMessage());
        }
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
