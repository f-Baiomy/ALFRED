package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.out.LogSourceStorePort;
import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** Sources, each with its structure as one JSON column, in logs.db. */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.logs", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteLogSourceStoreAdapter implements LogSourceStorePort {

    private static final RowMapper<LogSource> SOURCE = (rs, i) -> new LogSource(rs.getString("id"), rs.getString("name"),
            RawMode.valueOf(rs.getString("raw_mode")), PrivacyMode.valueOf(rs.getString("privacy_mode")),
            rs.getLong("retention_max_bytes"), rs.getLong("line_count"),
            rs.getLong("stored_bytes"), rs.getLong("unparsed_count"), rs.getString("created_at"), rs.getString("updated_at"));

    private final SqliteLogsRepository repository;
    private final ObjectMapper objectMapper;

    public SqliteLogSourceStoreAdapter(SqliteLogsRepository repository, ObjectMapper objectMapper) {
        this.repository = repository;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<LogSource> list() {
        return repository.jdbc().query("SELECT * FROM log_source ORDER BY created_at", SOURCE);
    }

    @Override
    public Optional<LogSource> get(String id) {
        return repository.jdbc().query("SELECT * FROM log_source WHERE id = ?", SOURCE, id).stream().findFirst();
    }

    /** Counts are owned by the ingest transaction; saving settings never overwrites them. */
    @Override
    public void save(LogSource s) {
        repository.jdbc().update("""
                INSERT INTO log_source (id, name, raw_mode, privacy_mode, retention_max_bytes, retention_max_days, line_count,
                  stored_bytes, unparsed_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, raw_mode = excluded.raw_mode, privacy_mode = excluded.privacy_mode,
                  retention_max_bytes = excluded.retention_max_bytes, updated_at = excluded.updated_at
                """, s.id(), s.name(), s.rawMode().name(), s.privacyMode().name(), s.retentionMaxBytes(), 0,
                s.lineCount(), s.storedBytes(), s.unparsedCount(), s.createdAt(), s.updatedAt());
    }

    @Override
    public void delete(String id) {
        repository.jdbc().update("DELETE FROM log_input WHERE source_id = ?", id);
        repository.jdbc().update("DELETE FROM log_source WHERE id = ?", id);
    }

    @Override
    public Optional<LogStructure> structure(String sourceId) {
        return repository.jdbc().query("SELECT structure_json FROM log_source WHERE id = ? AND structure_json IS NOT NULL",
                (rs, i) -> read(rs.getString(1)), sourceId).stream().findFirst();
    }

    @Override
    public void saveStructure(String sourceId, LogStructure structure) {
        try {
            repository.jdbc().update("UPDATE log_source SET structure_id = ?, structure_json = ?, updated_at = ? WHERE id = ?",
                    structure.id(), objectMapper.writeValueAsString(structure), Instant.now().toString(), sourceId);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialize structure", e);
        }
    }

    private LogStructure read(String json) {
        try {
            return objectMapper.readValue(json, LogStructure.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Stored structure is unreadable", e);
        }
    }

    @Override
    public List<LogSource> withStructureId(String structureId) {
        return repository.jdbc().query("SELECT * FROM log_source WHERE structure_id = ?", SOURCE, structureId);
    }

    @Override
    public void addCounts(String sourceId, long lines, long bytes, long unparsed) {
        repository.jdbc().update("UPDATE log_source SET line_count = line_count + ?, stored_bytes = stored_bytes + ?, "
                + "unparsed_count = unparsed_count + ? WHERE id = ?", lines, bytes, unparsed, sourceId);
    }

    @Override
    public long storageSizeBytes() {
        return repository.storageSizeBytes();
    }

    @Override
    public void setCounts(String sourceId, long lines, long bytes) {
        repository.jdbc().update("UPDATE log_source SET line_count = ?, stored_bytes = ? WHERE id = ?", lines, bytes, sourceId);
    }
}
