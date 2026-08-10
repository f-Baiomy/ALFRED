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
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * One JSON array file per cycle (SESSION_CYCLES_DIR/{cycleId}.json), same full-read/mutate/
 * full-rewrite shape as JsonFileCommentsStoreAdapter - chosen (over a JSON-lines log) specifically
 * because captured calls support removing a single entry by id, which needs a full rewrite either
 * way.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "file", matchIfMissing = true)
public class JsonFileCapturedCallsStoreAdapter implements CapturedCallsStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileCapturedCallsStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SESSION_CYCLES_DIR:/appdata/session-cycles}")
    private String sessionCyclesDir;

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
    public synchronized void deleteAllForCycle(String cycleId) {
        try {
            Files.deleteIfExists(fileFor(cycleId));
        } catch (IOException e) {
            log.error("Failed to delete captured-calls file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    private Path fileFor(String cycleId) {
        return Path.of(sessionCyclesDir, cycleId + ".json");
    }

    private List<CapturedCall> readAll(String cycleId) {
        Path path = fileFor(cycleId);
        if (!Files.exists(path)) {
            return new ArrayList<>();
        }
        try {
            CapturedCall[] parsed = objectMapper.readValue(Files.readString(path), CapturedCall[].class);
            return new ArrayList<>(List.of(parsed));
        } catch (IOException e) {
            log.warn("Could not read captured-calls file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(String cycleId, List<CapturedCall> calls) {
        try {
            Path path = fileFor(cycleId);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(calls));
        } catch (IOException e) {
            log.error("Failed to write captured-calls file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
