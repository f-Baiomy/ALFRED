package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.LegacyCycleSpacer;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
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
import java.util.function.UnaryOperator;

/**
 * One JSON array file per cycle (SESSION_CYCLES_DIR/{cycleId}.spacers.json), same full-read/mutate/
 * full-rewrite shape as JsonFileCapturedCallsStoreAdapter but deliberately uncached - a cycle has at
 * most a handful of spacers, so re-parsing this small file on every read isn't worth a cache entry.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "file")
public class JsonFileCycleSpacersStoreAdapter implements CycleSpacersStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileCycleSpacersStoreAdapter.class);

    /** The only anchorModel written - see Stored. */
    private static final String AFTER = "after";

    /**
     * What's actually in the file. A file written before spacers anchored to the call above them
     * holds {@code beforeCallId} and no {@code anchorModel}; such an entry is legacy until a move
     * converts it (mirrors the SQLite adapter's anchor_model column).
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Stored(String id, String cycleId, String label, String beforeCallId, String afterCallId,
                  String createdAt, String anchorTimestamp, String anchorModel) {

        boolean legacy() {
            return !AFTER.equals(anchorModel);
        }

        CycleSpacer toSpacer() {
            return new CycleSpacer(id, cycleId, label, legacy() ? null : afterCallId, createdAt, legacy() ? null : anchorTimestamp);
        }

        Stored withAnchor(String newAfterCallId, String newAnchorTimestamp) {
            return new Stored(id, cycleId, label, null, newAfterCallId, createdAt, newAnchorTimestamp, AFTER);
        }
    }

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
        return readAll(cycleId).stream().map(Stored::toSpacer).toList();
    }

    @Override
    public synchronized List<LegacyCycleSpacer> findLegacyByCycle(String cycleId) {
        return readAll(cycleId).stream()
                .filter(Stored::legacy)
                .map(stored -> new LegacyCycleSpacer(stored.id(), stored.beforeCallId(), stored.anchorTimestamp()))
                .toList();
    }

    @Override
    public synchronized CycleSpacer create(String cycleId, String label, String afterCallId, String anchorTimestamp) {
        Stored stored = new Stored(UUID.randomUUID().toString(), cycleId, label, null, afterCallId, Instant.now().toString(), anchorTimestamp, AFTER);
        List<Stored> all = readAll(cycleId);
        all.add(stored);
        writeAll(cycleId, all);
        return stored.toSpacer();
    }

    @Override
    public synchronized Optional<CycleSpacer> rename(String cycleId, String spacerId, String label) {
        return update(cycleId, spacerId, existing -> new Stored(existing.id(), existing.cycleId(), label, existing.beforeCallId(),
                existing.afterCallId(), existing.createdAt(), existing.anchorTimestamp(), existing.anchorModel()));
    }

    @Override
    public synchronized Optional<CycleSpacer> move(String cycleId, String spacerId, String afterCallId, String anchorTimestamp) {
        return update(cycleId, spacerId, existing -> existing.withAnchor(afterCallId, anchorTimestamp));
    }

    private Optional<CycleSpacer> update(String cycleId, String spacerId, UnaryOperator<Stored> mutation) {
        List<Stored> all = readAll(cycleId);
        for (int i = 0; i < all.size(); i++) {
            if (all.get(i).id().equals(spacerId)) {
                Stored updated = mutation.apply(all.get(i));
                all.set(i, updated);
                writeAll(cycleId, all);
                return Optional.of(updated.toSpacer());
            }
        }
        return Optional.empty();
    }

    @Override
    public synchronized boolean delete(String cycleId, String spacerId) {
        List<Stored> all = readAll(cycleId);
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
        List<Stored> all = readAll(cycleId);
        boolean changed = false;
        for (int i = 0; i < all.size(); i++) {
            Stored s = all.get(i);
            String anchor = s.legacy() ? s.beforeCallId() : s.afterCallId();
            if (anchor != null && capturedCallIds.contains(anchor)) {
                all.set(i, new Stored(s.id(), s.cycleId(), s.label(), s.legacy() ? null : s.beforeCallId(),
                        s.legacy() ? s.afterCallId() : null, s.createdAt(), s.anchorTimestamp(), s.anchorModel()));
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

    private List<Stored> readAll(String cycleId) {
        Path path = fileFor(cycleId);
        if (!Files.exists(path)) {
            return new ArrayList<>();
        }
        try {
            Stored[] parsed = objectMapper.readValue(Files.readString(path), Stored[].class);
            return new ArrayList<>(List.of(parsed));
        } catch (IOException e) {
            log.warn("Could not read spacers file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(String cycleId, List<Stored> spacers) {
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
