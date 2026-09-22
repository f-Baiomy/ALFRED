package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
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
import java.util.Optional;
import java.util.UUID;

/**
 * One JSON array file per cycle (SESSION_CYCLES_DIR/{cycleId}.spacers.json), same full-read/mutate/
 * full-rewrite shape as JsonFileCapturedCallsStoreAdapter but deliberately uncached - a cycle has at
 * most a handful of spacers, so re-parsing this small file on every read isn't worth a cache entry.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "file")
public class JsonFileCycleSpacersStoreAdapter implements CycleSpacersStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileCycleSpacersStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SESSION_CYCLES_DIR:/appdata/session-cycles}")
    private String sessionCyclesDir;

    @PostConstruct
    void checkStorageIsWritable() {
        Path dir = Path.of(sessionCyclesDir);
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            log.error("Could not create session-cycles directory {}: {}", dir, e.getMessage());
        }
    }

    @Override
    public synchronized List<CycleSpacer> findAllByCycle(String cycleId) {
        return readAll(cycleId);
    }

    @Override
    public synchronized CycleSpacer create(String cycleId, String label, String beforeCallId) {
        CycleSpacer spacer = new CycleSpacer(UUID.randomUUID().toString(), cycleId, label, beforeCallId, Instant.now().toString());
        List<CycleSpacer> all = readAll(cycleId);
        all.add(spacer);
        writeAll(cycleId, all);
        return spacer;
    }

    @Override
    public synchronized Optional<CycleSpacer> rename(String cycleId, String spacerId, String label) {
        return update(cycleId, spacerId, existing -> new CycleSpacer(existing.id(), existing.cycleId(), label, existing.beforeCallId(), existing.createdAt()));
    }

    @Override
    public synchronized Optional<CycleSpacer> move(String cycleId, String spacerId, String beforeCallId) {
        return update(cycleId, spacerId, existing -> new CycleSpacer(existing.id(), existing.cycleId(), existing.label(), beforeCallId, existing.createdAt()));
    }

    private Optional<CycleSpacer> update(String cycleId, String spacerId, java.util.function.UnaryOperator<CycleSpacer> mutation) {
        List<CycleSpacer> all = readAll(cycleId);
        CycleSpacer[] updated = new CycleSpacer[1];
        for (int i = 0; i < all.size(); i++) {
            if (all.get(i).id().equals(spacerId)) {
                updated[0] = mutation.apply(all.get(i));
                all.set(i, updated[0]);
                break;
            }
        }
        if (updated[0] == null) {
            return Optional.empty();
        }
        writeAll(cycleId, all);
        return Optional.of(updated[0]);
    }

    @Override
    public synchronized boolean delete(String cycleId, String spacerId) {
        List<CycleSpacer> all = readAll(cycleId);
        boolean removed = all.removeIf(s -> s.id().equals(spacerId));
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
            log.error("Failed to delete spacers file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public synchronized void dropAnchorsTo(String cycleId, List<String> capturedCallIds) {
        if (capturedCallIds.isEmpty()) {
            return;
        }
        List<CycleSpacer> all = readAll(cycleId);
        boolean changed = false;
        for (int i = 0; i < all.size(); i++) {
            CycleSpacer spacer = all.get(i);
            if (spacer.beforeCallId() != null && capturedCallIds.contains(spacer.beforeCallId())) {
                all.set(i, new CycleSpacer(spacer.id(), spacer.cycleId(), spacer.label(), null, spacer.createdAt()));
                changed = true;
            }
        }
        if (changed) {
            writeAll(cycleId, all);
        }
    }

    private Path fileFor(String cycleId) {
        return Path.of(sessionCyclesDir, cycleId + ".spacers.json");
    }

    private List<CycleSpacer> readAll(String cycleId) {
        Path path = fileFor(cycleId);
        if (!Files.exists(path)) {
            return new ArrayList<>();
        }
        try {
            CycleSpacer[] parsed = objectMapper.readValue(Files.readString(path), CycleSpacer[].class);
            return new ArrayList<>(List.of(parsed));
        } catch (IOException e) {
            log.warn("Could not read spacers file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(String cycleId, List<CycleSpacer> spacers) {
        try {
            Path path = fileFor(cycleId);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(spacers));
        } catch (IOException e) {
            log.error("Failed to write spacers file for cycle {}: {}", cycleId, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
