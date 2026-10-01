package com.fathy.alfred.backend.relive.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.domain.model.Hold;
import com.fathy.alfred.backend.relive.domain.model.LogEntry;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.Resumed;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.RunSummary;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.VariableChange;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

/**
 * Thin ReliveRunStorePort implementation - all SQL/JDBC detail lives in
 * {@link SqliteReliveRepository}. {@code size_bytes} is measured once at write time (the sum of
 * every JSON column's serialized length) so {@link #pruneRuns} never has to re-measure it.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.relive", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteReliveRunStoreAdapter implements ReliveRunStorePort {

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public SqliteReliveRunStoreAdapter(SqliteReliveRepository repository, ObjectMapper objectMapper) {
        this.jdbc = repository.jdbc();
        this.objectMapper = objectMapper;
    }

    @Override
    public Run create(Run run) {
        insertOrUpdate(run);
        return findById(run.id()).orElseThrow(() -> new IllegalStateException("Run " + run.id() + " vanished immediately after being created"));
    }

    @Override
    public Optional<Run> findById(String runId) {
        return jdbc.query("""
                SELECT id, cycle_id, status, driver, started_at, finished_at, summary_json,
                       definition_json, hold_json, resumed_json, variables_json, log_json
                FROM relive_runs WHERE id = ?
                """, DETAIL_ROW_MAPPER, runId).stream().findFirst();
    }

    @Override
    public List<Run> listByCycleId(String cycleId, int limit) {
        return jdbc.query("""
                SELECT id, cycle_id, status, driver, started_at, finished_at, summary_json
                FROM relive_runs WHERE cycle_id = ? ORDER BY rowid DESC LIMIT ?
                """, SUMMARY_ROW_MAPPER, cycleId, limit);
    }

    @Override
    public List<Run> findAllRunning() {
        return jdbc.query("""
                SELECT id, cycle_id, status, driver, started_at, finished_at, summary_json,
                       definition_json, hold_json, resumed_json, variables_json, log_json
                FROM relive_runs WHERE status = ?
                """, DETAIL_ROW_MAPPER, RunStatus.RUNNING.name());
    }

    @Override
    public Run update(Run run) {
        insertOrUpdate(run);
        return findById(run.id()).orElseThrow(() -> new IllegalStateException("Run " + run.id() + " vanished immediately after being updated"));
    }

    private void insertOrUpdate(Run run) {
        String summaryJson = writeJson(run.summary());
        String definitionJson = writeJson(run.definition());
        String holdJson = writeJson(run.hold());
        String resumedJson = writeJson(run.resumed());
        String variablesJson = writeJson(run.variableTimeline());
        String logJson = writeJson(run.log());
        long size = summaryJson.length() + definitionJson.length()
                + (holdJson == null ? 0 : holdJson.length())
                + (resumedJson == null ? 0 : resumedJson.length())
                + variablesJson.length() + logJson.length();
        jdbc.update("""
                        INSERT INTO relive_runs (id, cycle_id, status, driver, started_at, finished_at, summary_json,
                            definition_json, hold_json, resumed_json, variables_json, log_json, size_bytes)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
                            summary_json = excluded.summary_json, definition_json = excluded.definition_json,
                            hold_json = excluded.hold_json, resumed_json = excluded.resumed_json,
                            variables_json = excluded.variables_json, log_json = excluded.log_json,
                            size_bytes = excluded.size_bytes
                        """,
                run.id(), run.cycleId(), run.status().name(), run.driver(), run.startedAt(), run.finishedAt(),
                summaryJson, definitionJson, holdJson, resumedJson, variablesJson, logJson, size);
    }

    @Override
    public void putStepResult(StepResult result) {
        String resultJson = writeJson(result);
        jdbc.update("""
                        INSERT INTO relive_step_results (run_id, step_key, attempt, state, result_json, size_bytes)
                        VALUES (?,?,?,?,?,?)
                        ON CONFLICT(run_id, step_key, attempt) DO UPDATE SET state = excluded.state,
                            result_json = excluded.result_json, size_bytes = excluded.size_bytes
                        """,
                result.runId(), result.stepKey(), result.attempt(), result.state().name(), resultJson, resultJson.length());
    }

    @Override
    public List<StepResult> listStepResults(String runId) {
        return jdbc.query("""
                SELECT result_json FROM relive_step_results WHERE run_id = ? ORDER BY step_key, attempt
                """, (rs, n) -> readJson(rs.getString(1), StepResult.class), runId);
    }

    @Override
    public void pruneRuns(String cycleId, int keep, long maxBytes) {
        jdbc.update("""
                DELETE FROM relive_step_results WHERE run_id IN (
                    SELECT id FROM relive_runs WHERE cycle_id = ? AND id NOT IN (
                        SELECT id FROM relive_runs WHERE cycle_id = ? ORDER BY rowid DESC LIMIT ?
                    )
                )
                """, cycleId, cycleId, keep);
        jdbc.update("""
                DELETE FROM relive_runs WHERE cycle_id = ? AND id NOT IN (
                    SELECT id FROM relive_runs WHERE cycle_id = ? ORDER BY rowid DESC LIMIT ?
                )
                """, cycleId, cycleId, keep);
        // Size cap, oldest first, after the row-count cap has already applied.
        Long total = jdbc.queryForObject("SELECT COALESCE(SUM(size_bytes),0) FROM relive_runs WHERE cycle_id = ?", Long.class, cycleId);
        if (total == null || total <= maxBytes) {
            return;
        }
        List<String> oldestFirst = jdbc.query("""
                SELECT id, size_bytes FROM relive_runs WHERE cycle_id = ? ORDER BY rowid ASC
                """, (rs, n) -> rs.getString("id") + ":" + rs.getLong("size_bytes"), cycleId);
        long remaining = total;
        for (String entry : oldestFirst) {
            if (remaining <= maxBytes) {
                break;
            }
            String[] parts = entry.split(":", 2);
            jdbc.update("DELETE FROM relive_step_results WHERE run_id = ?", parts[0]);
            jdbc.update("DELETE FROM relive_runs WHERE id = ?", parts[0]);
            remaining -= Long.parseLong(parts[1]);
        }
    }

    @Override
    public void deleteByCycleId(String cycleId) {
        jdbc.update("DELETE FROM relive_step_results WHERE run_id IN (SELECT id FROM relive_runs WHERE cycle_id = ?)", cycleId);
        jdbc.update("DELETE FROM relive_runs WHERE cycle_id = ?", cycleId);
    }

    @Override
    public void deleteByIds(Collection<String> runIds) {
        if (runIds.isEmpty()) {
            return;
        }
        String placeholders = String.join(",", Collections.nCopies(runIds.size(), "?"));
        jdbc.update("DELETE FROM relive_step_results WHERE run_id IN (" + placeholders + ")", runIds.toArray());
        jdbc.update("DELETE FROM relive_runs WHERE id IN (" + placeholders + ")", runIds.toArray());
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not serialize relive run data", e));
        }
    }

    private <T> T readJson(String text, Class<T> type) {
        if (text == null) {
            return null;
        }
        try {
            return objectMapper.readValue(text, type);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not parse stored relive run JSON", e));
        }
    }

    private final RowMapper<Run> SUMMARY_ROW_MAPPER = (rs, rowNum) -> new Run(
            rs.getString("id"), rs.getString("cycle_id"), rs.getString("driver"),
            RunStatus.valueOf(rs.getString("status")), rs.getString("started_at"), rs.getString("finished_at"),
            null, null, Collections.emptyList(), Collections.emptyList(),
            readJson(rs.getString("summary_json"), RunSummary.class), null, Collections.emptyList(), Collections.emptyList());

    private final RowMapper<Run> DETAIL_ROW_MAPPER = (rs, rowNum) -> new Run(
            rs.getString("id"), rs.getString("cycle_id"), rs.getString("driver"),
            RunStatus.valueOf(rs.getString("status")), rs.getString("started_at"), rs.getString("finished_at"),
            readJson(rs.getString("definition_json"), ReliveCycle.class), null,
            Collections.emptyList(),
            readJsonList(rs.getString("variables_json"), VariableChange[].class),
            readJson(rs.getString("summary_json"), RunSummary.class),
            readJson(rs.getString("hold_json"), Hold.class),
            readJsonList(rs.getString("resumed_json"), Resumed[].class),
            readJsonList(rs.getString("log_json"), LogEntry[].class));

    private <T> List<T> readJsonList(String text, Class<T[]> arrayType) {
        if (text == null) {
            return Collections.emptyList();
        }
        try {
            T[] array = objectMapper.readValue(text, arrayType);
            return List.of(array);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not parse stored relive run JSON array", e));
        }
    }
}
