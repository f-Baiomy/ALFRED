package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
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
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * One JSON array file per cycle (INTERNAL_SESSION_CYCLES_DIR/{cycleId}.json) - mirrors
 * JsonFileCapturedCallsStoreAdapter's structure/caching approach exactly, but simpler: there is no
 * SQLite variant for this path (backend-internal-calls itself has no two-phase/SQLite concept), so
 * this is a plain {@code @Component}, not gated by a storage-type property. No id-backfill
 * codepath either - internal calls always have an id already by the time they're captured (see
 * NewInternalCallObserverPort), unlike the legacy migration concern the external adapter still
 * carries.
 */
@Component
public class JsonFileCapturedInternalCallsStoreAdapter implements CapturedInternalCallsStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileCapturedInternalCallsStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${INTERNAL_SESSION_CYCLES_DIR:/appdata/session-cycles-internal}")
    private String sessionCyclesDir;

    /** An immutable snapshot of one cycle's file, stamped with the size/mtime it was parsed at. */
    private record CacheEntry(List<CapturedInternalCall> calls, long size, long modifiedMillis) {}

    /** Same rationale/cap as JsonFileCapturedCallsStoreAdapter's own MAX_CACHED_CYCLES. */
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
                log.error("Internal session-cycles directory {} is not writable - capturing internal calls will fail", dir);
            }
        } catch (IOException e) {
            log.error("Could not create internal session-cycles directory {}: {}", dir, e.getMessage());
        }
    }

    @Override
    public synchronized List<CapturedInternalCall> findAllByCycle(String cycleId) {
        return readAll(cycleId);
    }

    @Override
    public synchronized CapturedInternalCall append(String cycleId, CallRecord call) {
        CapturedInternalCall captured = new CapturedInternalCall(UUID.randomUUID().toString(), Instant.now().toString(), call);
        List<CapturedInternalCall> all = readAll(cycleId);
        all.add(captured);
        writeAll(cycleId, all);
        return captured;
    }

    @Override
    public synchronized boolean removeById(String cycleId, String callId) {
        List<CapturedInternalCall> all = readAll(cycleId);
        boolean removed = all.removeIf(c -> c.id().equals(callId));
        if (removed) {
            writeAll(cycleId, all);
        }
        return removed;
    }

    @Override
    public synchronized int removeByIds(String cycleId, List<String> callIds) {
        Set<String> idSet = new HashSet<>(callIds);
        List<CapturedInternalCall> all = readAll(cycleId);
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
            log.error("Failed to delete captured-internal-calls file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Filters/sorts/paginates over the full in-memory list for this cycle, then maps to CapturedInternalCallSummary as the final step, matching CapturedInternalCallsStorePort's summary-only contract. */
    @Override
    public synchronized CallListSupport.Page<CapturedInternalCallSummary> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        CallListSupport.Page<CapturedInternalCall> page = CallListSupport.apply(
                findAllByCycle(cycleId), CapturedInternalCall::call, search, supplier, sort, offset, limit, paginationEnabled);
        return new CallListSupport.Page<>(page.items().stream().map(CapturedInternalCallSummary::of).toList(), page.total());
    }

    @Override
    public synchronized Optional<CapturedInternalCall> findByCallId(String cycleId, String callId) {
        return findAllByCycle(cycleId).stream().filter(c -> callId.equals(c.call().id())).findFirst();
    }

    /** Sums every per-cycle captured-internal-calls file under sessionCyclesDir. */
    @Override
    public synchronized long storageSizeBytes() {
        Path dir = Path.of(sessionCyclesDir);
        if (!Files.isDirectory(dir)) {
            return 0L;
        }
        try (var paths = Files.list(dir)) {
            return paths.filter(p -> p.getFileName().toString().endsWith(".json"))
                    .mapToLong(this::sizeOrZero)
                    .sum();
        } catch (IOException e) {
            return 0L;
        }
    }

    private long sizeOrZero(Path path) {
        try {
            return Files.size(path);
        } catch (IOException e) {
            return 0L;
        }
    }

    /** Sums each cycle file's captured-call count - reuses readAll() (and its cache) per cycle rather than a separate counting code path. */
    @Override
    public synchronized long countAll() {
        Path dir = Path.of(sessionCyclesDir);
        if (!Files.isDirectory(dir)) {
            return 0L;
        }
        try (var paths = Files.list(dir)) {
            return paths.filter(p -> p.getFileName().toString().endsWith(".json"))
                    .mapToLong(p -> {
                        String fileName = p.getFileName().toString();
                        String cycleId = fileName.substring(0, fileName.length() - ".json".length());
                        return readAll(cycleId).size();
                    })
                    .sum();
        } catch (IOException e) {
            return 0L;
        }
    }

    /** Deletes every cycle's captured-internal-calls file - the Database settings tab's "Clear cycles" action. */
    @Override
    public synchronized void deleteAll() {
        Path dir = Path.of(sessionCyclesDir);
        if (!Files.isDirectory(dir)) {
            cacheByCycle.clear();
            return;
        }
        try (var paths = Files.list(dir)) {
            paths.filter(p -> p.getFileName().toString().endsWith(".json")).forEach(p -> {
                try {
                    Files.delete(p);
                } catch (IOException e) {
                    log.error("Failed to delete captured-internal-calls file {}: {}", p, e.getMessage());
                }
            });
        } catch (IOException e) {
            log.error("Failed to list internal session-cycles directory {} while clearing: {}", dir, e.getMessage());
        }
        cacheByCycle.clear();
    }

    private Path fileFor(String cycleId) {
        return Path.of(sessionCyclesDir, cycleId + ".json");
    }

    /** Returns a fresh mutable copy - append/removeById mutate what they get back, and the cached snapshot itself must stay immutable. */
    private List<CapturedInternalCall> readAll(String cycleId) {
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
            CapturedInternalCall[] parsed = objectMapper.readValue(Files.readString(path), CapturedInternalCall[].class);
            List<CapturedInternalCall> calls = new ArrayList<>(List.of(parsed));
            rememberCache(cycleId, path, calls);
            return new ArrayList<>(calls);
        } catch (IOException e) {
            cacheByCycle.remove(cycleId);
            log.warn("Could not read captured-internal-calls file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(String cycleId, List<CapturedInternalCall> calls) {
        try {
            Path path = fileFor(cycleId);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(calls));
            rememberCache(cycleId, path, calls);
        } catch (IOException e) {
            cacheByCycle.remove(cycleId);
            log.error("Failed to write captured-internal-calls file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Caches an immutable snapshot stamped with the file's current size/mtime - or drops the entry entirely if the file can't be stat'd, so the next read re-parses rather than trusting an unverifiable snapshot. */
    private void rememberCache(String cycleId, Path path, List<CapturedInternalCall> calls) {
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
