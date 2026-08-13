package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

/**
 * Thin CallLogPort implementation - every actual SQL/JDBC detail lives in
 * {@link SqliteCallsRepository}; this class only wires it to the port and runs the one-time
 * legacy-file migration. The new default (holding RECENT_CALLS.log entirely in memory doesn't
 * scale) - set {@code alfred.storage.calls.type=file} to opt back into {@code FileCallLogAdapter}.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.calls", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteCallLogAdapter implements CallLogPort {

    private static final Logger log = LoggerFactory.getLogger(SqliteCallLogAdapter.class);

    private final SqliteCallsRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${RECENT_CALLS_FILE:/appdata/RECENT_CALLS.log}")
    private String legacyFile;

    public SqliteCallLogAdapter(SqliteCallsRepository repository) {
        this.repository = repository;
    }

    /**
     * One-time, safely-rerunnable migration of RECENT_CALLS.log into calls.db - skipped once the
     * table already has rows (covers both "already migrated" and "started fresh on SQLite"), and
     * skipped if the legacy file doesn't exist. Streams line by line (never Files.readAllLines,
     * which would defeat the point for a large legacy file) inside one transaction, then renames
     * the legacy file to *.migrated so it's kept as a backup but never re-read.
     */
    @PostConstruct
    void migrateLegacyFileIfPresent() {
        Path path = Path.of(legacyFile);
        if (!Files.exists(path) || repository.count() > 0) {
            return;
        }
        int migrated = 0;
        int skipped = 0;
        try (var lines = Files.lines(path)) {
            for (String rawLine : (Iterable<String>) lines::iterator) {
                String trimmed = rawLine.strip();
                if (trimmed.isEmpty()) {
                    continue;
                }
                try {
                    CallRecord call = objectMapper.readValue(trimmed, CallRecord.class);
                    repository.save(SqliteCallsRepository.withGeneratedIdIfMissing(call));
                    migrated++;
                } catch (IOException e) {
                    skipped++;
                    log.warn("Skipping malformed legacy line while migrating {}: {}", path, e.getMessage());
                }
            }
        } catch (IOException e) {
            log.error("Failed to read legacy file {} during migration: {}", path, e.getMessage());
            return;
        }
        try {
            Files.move(path, path.resolveSibling(path.getFileName() + ".migrated"));
        } catch (IOException e) {
            log.warn("Migrated {} call(s) from {} but could not rename it to *.migrated: {}", migrated, path, e.getMessage());
        }
        log.info("Migrated {} call(s) ({} skipped as malformed) from {} into calls.db", migrated, skipped, path);
    }

    @Override
    public List<CallRecord> readAll() {
        return repository.readAll();
    }

    @Override
    public void save(CallRecord call) {
        repository.save(call);
    }

    @Override
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        return repository.query(search, supplier, sort, offset, limit, paginationEnabled);
    }

    @Override
    public Optional<CallRecord> findById(String id) {
        return repository.findById(id);
    }
}
