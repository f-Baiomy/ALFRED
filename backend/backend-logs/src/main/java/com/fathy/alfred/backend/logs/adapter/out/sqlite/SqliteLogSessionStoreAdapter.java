package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.out.LogSessionStorePort;
import com.fathy.alfred.backend.logs.domain.model.LogSession;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/** Recorded sessions in logs.db, one JSON document per session (markers and filter included). */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.logs", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteLogSessionStoreAdapter implements LogSessionStorePort {

    private final SqliteLogsRepository repository;
    private final ObjectMapper mapper;

    public SqliteLogSessionStoreAdapter(SqliteLogsRepository repository, ObjectMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    private LogSession read(String json) {
        try {
            return mapper.readValue(json, LogSession.class);
        } catch (Exception e) {
            throw new IllegalStateException("Stored session is unreadable", e);
        }
    }

    @Override
    public void save(LogSession s) {
        try {
            repository.jdbc().update("INSERT INTO log_session (id, source_id, json, started_at) VALUES (?,?,?,?) "
                    + "ON CONFLICT(id) DO UPDATE SET json = excluded.json", s.id(), s.sourceId(), mapper.writeValueAsString(s), s.startedAt());
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("Could not serialize session", e);
        }
    }

    @Override
    public Optional<LogSession> get(String id) {
        return repository.jdbc().query("SELECT json FROM log_session WHERE id = ?", (rs, i) -> read(rs.getString(1)), id).stream().findFirst();
    }

    @Override
    public List<LogSession> bySource(String sourceId) {
        return repository.jdbc().query("SELECT json FROM log_session WHERE source_id = ? ORDER BY started_at DESC",
                (rs, i) -> read(rs.getString(1)), sourceId);
    }

    @Override
    public void delete(String id) {
        repository.jdbc().update("DELETE FROM log_session WHERE id = ?", id);
    }

    @Override
    public void deleteSource(String sourceId) {
        repository.jdbc().update("DELETE FROM log_session WHERE source_id = ?", sourceId);
    }
}
