package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
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
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * One JSON array file per cycle (SESSION_CYCLES_DIR/{cycleId}.json), same full-read/mutate/
 * full-rewrite shape as JsonFileCommentsStoreAdapter - chosen (over a JSON-lines log) specifically
 * because captured calls support removing a single entry by id, which needs a full rewrite either
 * way.
 *
 * <p>Parsed contents are cached in memory per cycle, keyed by cycle id and validated against each
 * file's size/last-modified-time on every read (same approach and rationale as
 * FileCallLogAdapter). This file is read on two hot paths that both used to re-parse it in full:
 * every webhook call fans out to each RECORDING cycle via SessionCycleCaptureAdapter (read + write
 * per cycle, per call), and an open cycle-detail page polls its captured calls every 5s - with
 * whole request/response bodies in every entry.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "file", matchIfMissing = true)
public class JsonFileCapturedCallsStoreAdapter implements CapturedCallsStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileCapturedCallsStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SESSION_CYCLES_DIR:/appdata/session-cycles}")
    private String sessionCyclesDir;

    /** An immutable snapshot of one cycle's file, stamped with the size/mtime it was parsed at. */
    private record CacheEntry(List<CapturedCall> calls, long size, long modifiedMillis) {}

    /** Caps how many cycles' captured-call bodies (potentially large XML/JSON, per cycle) stay warm
     * in memory at once - without this, a long-running server accumulates one entry per session-cycle
     * ever created (evicted only by explicit deletion, never by inactivity), growing without bound
     * over the process lifetime even though each entry's own file is capped by nothing. Well above
     * any realistic number of cycles someone has open across tabs at once, so eviction only ever
     * affects cycles nobody's actively looking at - the next read just re-parses from disk. */
    private static final int MAX_CACHED_CYCLES = 20;

    /** Per-cycle, since each cycle is its own file. Only ever touched from synchronized methods.
     * Access-ordered so removeEldestEntry evicts the least-recently-touched cycle, not an arbitrary one. */
    private final Map<String, CacheEntry> cacheByCycle = new LinkedHashMap<>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, CacheEntry> eldest) {
            return size() > MAX_CACHED_CYCLES;
        }
    };

    @PostConstruct
    void checkStorageIsWritable() {
        Path dir = Path.of(sessionCyclesDir);
        try {
            Files.createDirectories(dir);
            if (!Files.isWritable(dir)) {
                log.error("Session-cycles directory {} is not writable - capturing calls will fail", dir);
            }
        } catch (IOException e) {
            log.error("Could not create session-cycles directory {}: {}", dir, e.getMessage());
        }
    }

    @Override
    public synchronized List<CapturedCall> findAllByCycle(String cycleId) {
        return readAll(cycleId);
    }

    @Override
    public synchronized CapturedCall append(String cycleId, CallRecord call) {
        CapturedCall captured = new CapturedCall(UUID.randomUUID().toString(), Instant.now().toString(), call);
        List<CapturedCall> all = readAll(cycleId);
        all.add(captured);
        writeAll(cycleId, all);
        return captured;
    }

    @Override
    public synchronized boolean removeById(String cycleId, String callId) {
        List<CapturedCall> all = readAll(cycleId);
        boolean removed = all.removeIf(c -> c.id().equals(callId));
        if (removed) {
            writeAll(cycleId, all);
        }
        return removed;
    }

    @Override
    public synchronized int removeByIds(String cycleId, List<String> callIds) {
        Set<String> idSet = new HashSet<>(callIds);
        List<CapturedCall> all = readAll(cycleId);
        int before = all.size();
        all.removeIf(c -> idSet.contains(c.id()));
        int removedCount = before - all.size();
        if (removedCount > 0) {
            writeAll(cycleId, all);
        }
        return removedCount;
    }

    @Override
    public synchronized void deleteAllForCycle(String cycleId) {
        try {
            Files.deleteIfExists(fileFor(cycleId));
            cacheByCycle.remove(cycleId);
        } catch (IOException e) {
            cacheByCycle.remove(cycleId);
            log.error("Failed to delete captured-calls file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    private Path fileFor(String cycleId) {
        return Path.of(sessionCyclesDir, cycleId + ".json");
    }

    /** Returns a fresh mutable copy - append/removeById mutate what they get back, and the cached snapshot itself must stay immutable. */
    private List<CapturedCall> readAll(String cycleId) {
        Path path = fileFor(cycleId);
        if (!Files.exists(path)) {
            cacheByCycle.remove(cycleId);
            return new ArrayList<>();
        }

        BasicFileAttributes attributes = readAttributes(path);
        CacheEntry cached = cacheByCycle.get(cycleId);
        if (cached != null && attributes != null
                && attributes.size() == cached.size()
                && attributes.lastModifiedTime().toMillis() == cached.modifiedMillis()) {
            return new ArrayList<>(cached.calls());
        }

        try {
            CapturedCall[] parsed = objectMapper.readValue(Files.readString(path), CapturedCall[].class);
            List<CapturedCall> calls = new ArrayList<>(List.of(parsed));

            // Written before CallRecord had an id - backfilled once here rather than left to
            // regenerate a different id on every read, which would make comments' migration to
            // real call ids (see the one-time startup migration in backend-app) permanently
            // unable to keep matching this call.
            boolean needsBackfill = false;
            for (int i = 0; i < calls.size(); i++) {
                CapturedCall captured = calls.get(i);
                if (captured.call().id() == null) {
                    calls.set(i, new CapturedCall(captured.id(), captured.capturedAt(), withGeneratedId(captured.call())));
                    needsBackfill = true;
                }
            }

            if (needsBackfill) {
                writeAll(cycleId, calls);
            } else {
                rememberCache(cycleId, path, calls);
            }
            return new ArrayList<>(calls);
        } catch (IOException e) {
            cacheByCycle.remove(cycleId);
            log.warn("Could not read captured-calls file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private static CallRecord withGeneratedId(CallRecord call) {
        return new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(), call.method(),
                call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }

    private void writeAll(String cycleId, List<CapturedCall> calls) {
        try {
            Path path = fileFor(cycleId);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(calls));
            rememberCache(cycleId, path, calls);
        } catch (IOException e) {
            cacheByCycle.remove(cycleId);
            log.error("Failed to write captured-calls file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Caches an immutable snapshot stamped with the file's current size/mtime - or drops the entry entirely if the file can't be stat'd, so the next read re-parses rather than trusting an unverifiable snapshot. */
    private void rememberCache(String cycleId, Path path, List<CapturedCall> calls) {
        BasicFileAttributes attributes = readAttributes(path);
        if (attributes == null) {
            cacheByCycle.remove(cycleId);
            return;
        }
        cacheByCycle.put(cycleId, new CacheEntry(List.copyOf(calls), attributes.size(), attributes.lastModifiedTime().toMillis()));
    }

    private BasicFileAttributes readAttributes(Path path) {
        try {
            return Files.readAttributes(path, BasicFileAttributes.class);
        } catch (IOException e) {
            return null;
        }
    }
}
