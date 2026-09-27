package com.fathy.alfred.backend.relive.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Optional;

/**
 * Thin LiveCallStorePort implementation - all SQL/JDBC detail lives in
 * {@link SqliteReliveRepository}. Deliberately has no prune method (FR-015b): the only way a row
 * leaves this table is {@link #deleteById}.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.relive", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteLiveCallStoreAdapter implements LiveCallStorePort {

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public SqliteLiveCallStoreAdapter(SqliteReliveRepository repository, ObjectMapper objectMapper) {
        this.jdbc = repository.jdbc();
        this.objectMapper = objectMapper;
    }

    @Override
    public LiveCall add(LiveCall call) {
        String requestJson = writeJson(call.request());
        String responseJson = writeJson(call.response());
        long size = requestJson.length() + responseJson.length();
        jdbc.update("""
                        INSERT INTO relive_live_calls (id, cycle_id, run_id, step_key, reason, method, url, status,
                            duration_ms, at, request_json, response_json, size_bytes)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                call.id(), call.cycleId(), call.runId(), call.stepKey(), call.reason(),
                requestMethod(call), requestUrl(call), call.status(), call.durationMs(), call.at(),
                requestJson, responseJson, size);
        return findById(call.id()).orElseThrow(() -> new IllegalStateException("Live call " + call.id() + " vanished immediately after being added"));
    }

    @Override
    public List<LiveCall> list(String cycleId, int limit) {
        return jdbc.query("""
                SELECT id, cycle_id, run_id, step_key, reason, method, url, status, duration_ms, at
                FROM relive_live_calls WHERE cycle_id = ? ORDER BY rowid DESC LIMIT ?
                """, SUMMARY_ROW_MAPPER, cycleId, limit);
    }

    @Override
    public Optional<LiveCall> findById(String id) {
        return jdbc.query("""
                SELECT id, cycle_id, run_id, step_key, reason, status, duration_ms, at, request_json, response_json
                FROM relive_live_calls WHERE id = ?
                """, DETAIL_ROW_MAPPER, id).stream().findFirst();
    }

    @Override
    public boolean deleteById(String id) {
        return jdbc.update("DELETE FROM relive_live_calls WHERE id = ?", id) > 0;
    }

    @Override
    public long totalBytes(String cycleId) {
        Long total = jdbc.queryForObject("SELECT COALESCE(SUM(size_bytes),0) FROM relive_live_calls WHERE cycle_id = ?", Long.class, cycleId);
        return total == null ? 0L : total;
    }

    private String requestMethod(LiveCall call) {
        return call.request() != null && call.request().has("method") ? call.request().get("method").asText("") : "";
    }

    private String requestUrl(LiveCall call) {
        return call.request() != null && call.request().has("url") ? call.request().get("url").asText("") : "";
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value == null ? objectMapper.nullNode() : value);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not serialize live call data", e));
        }
    }

    private com.fasterxml.jackson.databind.JsonNode readJson(String text) {
        if (text == null) {
            return null;
        }
        try {
            return objectMapper.readTree(text);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not parse stored live call JSON", e));
        }
    }

    private final RowMapper<LiveCall> SUMMARY_ROW_MAPPER = (rs, rowNum) -> new LiveCall(
            rs.getString("id"), rs.getString("cycle_id"), rs.getString("run_id"), rs.getString("step_key"),
            rs.getString("reason"), null, null, null, rs.getInt("status"), rs.getLong("duration_ms"), rs.getString("at"));

    private final RowMapper<LiveCall> DETAIL_ROW_MAPPER = (rs, rowNum) -> new LiveCall(
            rs.getString("id"), rs.getString("cycle_id"), rs.getString("run_id"), rs.getString("step_key"),
            rs.getString("reason"), null, readJson(rs.getString("request_json")), readJson(rs.getString("response_json")),
            rs.getInt("status"), rs.getLong("duration_ms"), rs.getString("at"));
}
