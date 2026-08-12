package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;

/**
 * One-time, safely-rerunnable migration of session-cycles.json + each per-cycle {cycleId}.json
 * file into session-cycles.db - skipped once session_cycles already has rows (covers both
 * "already migrated" and "started fresh on SQLite"). Lives in its own component rather than
 * either adapter's constructor since it needs both tables (cycles, then each cycle's captured
 * calls) migrated together in the right order.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteSessionCyclesMigration {

    private static final Logger log = LoggerFactory.getLogger(SqliteSessionCyclesMigration.class);

    private final SqliteSessionCyclesRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SESSION_CYCLES_FILE:/appdata/session-cycles/session-cycles.json}")
    private String legacyMetadataFile;

    @Value("${SESSION_CYCLES_DIR:/appdata/session-cycles}")
    private String legacyCapturedCallsDir;

    public SqliteSessionCyclesMigration(SqliteSessionCyclesRepository repository) {
        this.repository = repository;
    }

    @PostConstruct
    void migrateIfPresent() {
        if (repository.cycleCount() > 0) {
            return;
        }
        Path metadataPath = Path.of(legacyMetadataFile);
        if (!Files.exists(metadataPath)) {
            return;
        }

        Set<String> migratedCycleIds = new HashSet<>();
        try {
            SessionCycle[] cycles = objectMapper.readValue(Files.readString(metadataPath), SessionCycle[].class);
            for (SessionCycle cycle : cycles) {
                repository.saveCycle(cycle);
                migratedCycleIds.add(cycle.id());
                migrateCapturedCallsFor(cycle.id());
            }
            log.info("Migrated {} session cycle(s) from {} into session-cycles.db", cycles.length, metadataPath);
        } catch (IOException e) {
            log.error("Failed to read legacy session-cycles metadata file {} during migration: {}", metadataPath, e.getMessage());
            return;
        }

        migrateOrphanedCapturedCallsFiles(migratedCycleIds);

        try {
            Files.move(metadataPath, metadataPath.resolveSibling(metadataPath.getFileName() + ".migrated"));
        } catch (IOException e) {
            log.warn("Migrated session-cycles metadata but could not rename {} to *.migrated: {}", metadataPath, e.getMessage());
        }
    }

    /** Any {cycleId}.json file not referenced by session-cycles.json - migrated anyway (captured_calls.cycle_id has no foreign-key constraint) rather than silently dropped, since the calls themselves may still matter even if their cycle's metadata was lost. */
    private void migrateOrphanedCapturedCallsFiles(Set<String> alreadyMigratedCycleIds) {
        Path dir = Path.of(legacyCapturedCallsDir);
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "*.json")) {
            for (Path file : stream) {
                String fileName = file.getFileName().toString();
                String cycleId = fileName.substring(0, fileName.length() - ".json".length());
                if (alreadyMigratedCycleIds.contains(cycleId) || file.equals(Path.of(legacyMetadataFile))) {
                    continue;
                }
                migrateCapturedCallsFor(cycleId);
            }
        } catch (IOException e) {
            log.warn("Could not scan {} for orphaned captured-calls files: {}", dir, e.getMessage());
        }
    }

    private void migrateCapturedCallsFor(String cycleId) {
        Path file = Path.of(legacyCapturedCallsDir, cycleId + ".json");
        if (!Files.exists(file)) {
            return;
        }
        try {
            CapturedCall[] captured = objectMapper.readValue(Files.readString(file), CapturedCall[].class);
            for (CapturedCall call : captured) {
                CallRecord withId = SqliteSessionCyclesRepository.withGeneratedIdIfMissing(call.call());
                repository.insert(cycleId, new CapturedCall(call.id(), call.capturedAt(), withId));
            }
            Files.move(file, file.resolveSibling(file.getFileName() + ".migrated"));
            log.info("Migrated {} captured call(s) for cycle {} from {} into session-cycles.db", captured.length, cycleId, file);
        } catch (IOException e) {
            log.error("Failed to migrate captured-calls file {} for cycle {}: {}", file, cycleId, e.getMessage());
        }
    }
}
