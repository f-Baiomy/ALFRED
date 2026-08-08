package com.alfred.pennyworth.sessioncycles.adapter.out.filestore;

import com.alfred.pennyworth.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Session-cycle metadata (name, createdAt, assignedTo, status) as a flat JSON file - same
 * full-read/mutate/full-rewrite shape JsonFileCommentsStoreAdapter already establishes for
 * comments.json. Swapping to Redis/MySQL later means a new SessionCycleMetadataStorePort
 * implementation with its own havingValue, not touching SessionCyclesService.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "file", matchIfMissing = true)
public class JsonFileSessionCycleMetadataStoreAdapter implements SessionCycleMetadataStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileSessionCycleMetadataStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SESSION_CYCLES_FILE:/appdata/session-cycles/session-cycles.json}")
    private String sessionCyclesFile;

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

    private List<SessionCycle> readAll() {
        Path path = Path.of(sessionCyclesFile);
        if (!Files.exists(path)) {
            return new ArrayList<>();
        }
        try {
            SessionCycle[] parsed = objectMapper.readValue(Files.readString(path), SessionCycle[].class);
            return new ArrayList<>(List.of(parsed));
        } catch (IOException e) {
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
        } catch (IOException e) {
            log.error("Failed to write session-cycles file {}: {}", sessionCyclesFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
