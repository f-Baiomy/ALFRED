package com.fathy.alfred.backend.scenarios.adapter.out.sqlite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioRunStorePort;
import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;
import com.fathy.alfred.backend.scenarios.domain.model.RunOutcome;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Optional;

/**
 * Thin ScenarioRunStorePort implementation over the same scenarios.db as
 * {@link SqliteScenarioStoreAdapter} (see {@link SqliteScenariosRepository}'s doc for why one
 * repository backs two adapters). {@code results_json} is a TEXT column read only by
 * {@link #findById}: {@link #findByScenarioId} never selects it, so listing a scenario's run
 * history never loads a run's (up to 20 MB) results just to show its pass/fail counts - same
 * meta/body split as backend-interception's SqliteStoredAnswersStoreAdapter.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.scenarios", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteScenarioRunStoreAdapter implements ScenarioRunStorePort {

    private static final String LIST_COLUMNS = "id, scenario_id, started_at, finished_at, summary_total, summary_passed, summary_failed, summary_errored";
    private static final String DETAIL_COLUMNS = LIST_COLUMNS + ", results_json";

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public SqliteScenarioRunStoreAdapter(SqliteScenariosRepository repository) {
        this.jdbc = repository.jdbc();
    }

    @Override
    public List<RunListItem> findByScenarioId(String scenarioId) {
        return jdbc.query("SELECT " + LIST_COLUMNS + " FROM scenario_runs WHERE scenario_id = ? ORDER BY rowid DESC",
                LIST_ROW_MAPPER, scenarioId);
    }

    @Override
    public Optional<Run> findById(String scenarioId, String runId) {
        return jdbc.query("SELECT " + DETAIL_COLUMNS + " FROM scenario_runs WHERE scenario_id = ? AND id = ?",
                DETAIL_ROW_MAPPER, scenarioId, runId).stream().findFirst();
    }

    @Override
    public synchronized Run save(Run run, int retentionLimit) {
        jdbc.update("INSERT INTO scenario_runs (" + DETAIL_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?)",
                run.id(), run.scenarioId(), run.startedAt(), run.finishedAt(),
                run.summary().total(), run.summary().passed(), run.summary().failed(), run.summary().errored(),
                writeJson(run.results()));

        // Retention: keep only the newest `retentionLimit` runs for this scenario (contracts/
        // 002-power-features section 3: "keeps newest 50 runs per scenario"). Synchronized with
        // the insert above so two concurrent runs for the same scenario can't both pass the
        // "still under the cap" check and leave more than the cap behind.
        jdbc.update("""
                DELETE FROM scenario_runs WHERE scenario_id = ? AND id NOT IN (
                    SELECT id FROM scenario_runs WHERE scenario_id = ? ORDER BY rowid DESC LIMIT ?
                )
                """, run.scenarioId(), run.scenarioId(), retentionLimit);

        return run;
    }

    @Override
    public void deleteByScenarioId(String scenarioId) {
        jdbc.update("DELETE FROM scenario_runs WHERE scenario_id = ?", scenarioId);
    }

    private String writeJson(JsonNode node) {
        try {
            return objectMapper.writeValueAsString(node == null ? objectMapper.nullNode() : node);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not serialize run results", e));
        }
    }

    private static JsonNode readJson(ObjectMapper mapper, String text) {
        if (text == null) {
            return null;
        }
        try {
            return mapper.readTree(text);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not parse stored run results", e));
        }
    }

    private static RunOutcome summaryOf(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new RunOutcome(rs.getInt("summary_total"), rs.getInt("summary_passed"),
                rs.getInt("summary_failed"), rs.getInt("summary_errored"));
    }

    private static final RowMapper<RunListItem> LIST_ROW_MAPPER = (rs, rowNum) -> new RunListItem(
            rs.getString("id"), rs.getString("scenario_id"), rs.getString("started_at"), rs.getString("finished_at"),
            summaryOf(rs));

    private final RowMapper<Run> DETAIL_ROW_MAPPER = (rs, rowNum) -> new Run(
            rs.getString("id"), rs.getString("scenario_id"), rs.getString("started_at"), rs.getString("finished_at"),
            summaryOf(rs), readJson(objectMapper, rs.getString("results_json")));
}
