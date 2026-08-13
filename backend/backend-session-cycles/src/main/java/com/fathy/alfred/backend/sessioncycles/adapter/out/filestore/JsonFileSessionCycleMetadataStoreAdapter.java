package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Session-cycle metadata (name, createdAt, assignedTo, status) as a flat JSON file - same
 * full-read/mutate/full-rewrite shape JsonFileCommentsStoreAdapter already establishes for
 * comments.json. Swapping to Redis/MySQL later means a new SessionCycleMetadataStorePort
 * implementation with its own havingValue, not touching SessionCyclesService.
 *
 * <p>Parsed contents are cached in memory and validated against the file's size/last-modified-time
 * on every read (same approach and rationale as FileCallLogAdapter). findAll() is on a hot path
 * twice over: SessionCycleCaptureAdapter calls it for every single webhook call to find which
 * cycles are RECORDING, and the Session Cycles page polls it every 5s.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "file")
public class JsonFileSessionCycleMetadataStoreAdapter implements SessionCycleMetadataStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileSessionCycleMetadataStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SESSION_CYCLES_FILE:/appdata/session-cycles/session-cycles.json}")
    private String sessionCyclesFile;

    /** Null until the first read/write populates it. Immutable - replaced wholesale, never mutated in place. */
    private List<SessionCycle> cachedCycles;
    private long cachedFileSize = -1;
    private long cachedModifiedMillis = -1;

    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(sessionCyclesFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Session-cycles directory {} is not writable - creating cycles will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create session-cycles directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public synchronized List<SessionCycle> findAll() {
        return readAll();
    }

    @Override
    public synchronized Optional<SessionCycle> findById(String id) {
        return readAll().stream().filter(c -> c.id().equals(id)).findFirst();
    }

    @Override
    public synchronized SessionCycle save(SessionCycle cycle) {
        List<SessionCycle> all = readAll();
        all.removeIf(c -> c.id().equals(cycle.id()));
        all.add(cycle);
        writeAll(all);
        return cycle;
    }

    @Override
    public synchronized boolean deleteById(String id) {
        List<SessionCycle> all = readAll();
        boolean removed = all.removeIf(c -> c.id().equals(id));
        if (removed) {
            writeAll(all);
        }
        return removed;
    }

    @Override
    public synchronized void deleteAll() {
        writeAll(new ArrayList<>());
    }

    /** Returns a fresh mutable copy - save/deleteById mutate what they get back, and the cached snapshot itself must stay immutable. */
    private List<SessionCycle> readAll() {
        Path path = Path.of(sessionCyclesFile);
        if (!Files.exists(path)) {
            invalidateCache();
            return new ArrayList<>();
        }

        BasicFileAttributes attributes = readAttributes(path);
        if (cachedCycles != null && attributes != null
                && attributes.size() == cachedFileSize
                && attributes.lastModifiedTime().toMillis() == cachedModifiedMillis) {
            return new ArrayList<>(cachedCycles);
        }

        try {
            SessionCycle[] parsed = objectMapper.readValue(Files.readString(path), SessionCycle[].class);
            List<SessionCycle> cycles = List.of(parsed);
            rememberCache(path, cycles);
            return new ArrayList<>(cycles);
        } catch (IOException e) {
            invalidateCache();
            log.warn("Could not read session-cycles file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(List<SessionCycle> cycles) {
        try {
            Path path = Path.of(sessionCyclesFile);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(cycles));
            rememberCache(path, cycles);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to write session-cycles file {}: {}", sessionCyclesFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Caches an immutable snapshot stamped with the file's current size/mtime - or invalidates instead if the file can't be stat'd, so the next read re-parses rather than trusting an unverifiable snapshot. */
    private void rememberCache(Path path, List<SessionCycle> cycles) {
        BasicFileAttributes attributes = readAttributes(path);
        if (attributes == null) {
            invalidateCache();
            return;
        }
        cachedCycles = List.copyOf(cycles);
        cachedFileSize = attributes.size();
        cachedModifiedMillis = attributes.lastModifiedTime().toMillis();
    }

    private void invalidateCache() {
        cachedCycles = null;
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
