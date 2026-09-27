package com.fathy.alfred.backend.scenarios.adapter.out.sqlite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioStorePort;
import com.fathy.alfred.backend.scenarios.domain.model.RunOutcome;
import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioSummary;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

/**
 * Thin ScenarioStorePort implementation - all SQL/JDBC detail lives in
 * {@link SqliteScenariosRepository}. {@code lastRun} is never a column on the scenarios table
 * itself - it's a correlated subquery against scenario_runs (the newest row by rowid), computed
 * fresh on every read rather than denormalized, so a run created via ScenarioRunStorePort never
 * needs to also update this table.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.scenarios", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteScenarioStoreAdapter implements ScenarioStorePort {

    private static final String LAST_RUN_SUBSELECTS = """
            (SELECT summary_total FROM scenario_runs r WHERE r.scenario_id = s.id ORDER BY r.rowid DESC LIMIT 1) AS last_total,
            (SELECT summary_passed FROM scenario_runs r WHERE r.scenario_id = s.id ORDER BY r.rowid DESC LIMIT 1) AS last_passed,
            (SELECT summary_failed FROM scenario_runs r WHERE r.scenario_id = s.id ORDER BY r.rowid DESC LIMIT 1) AS last_failed,
            (SELECT summary_errored FROM scenario_runs r WHERE r.scenario_id = s.id ORDER BY r.rowid DESC LIMIT 1) AS last_errored
            """;

    private final JdbcTemplate jdbc;
    private final SqliteScenariosRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public SqliteScenarioStoreAdapter(SqliteScenariosRepository repository) {
        this.repository = repository;
        this.jdbc = repository.jdbc();
    }

    @Override
    public List<ScenarioSummary> findAllSummaries() {
        String sql = "SELECT s.id, s.name, s.description, s.created_at, s.updated_at, " + LAST_RUN_SUBSELECTS
                + "FROM scenarios s ORDER BY s.rowid DESC";
        return jdbc.query(sql, SUMMARY_ROW_MAPPER);
    }

    @Override
    public Optional<Scenario> findById(String id) {
        String sql = "SELECT s.id, s.name, s.description, s.definition_json, s.created_at, s.updated_at, " + LAST_RUN_SUBSELECTS
                + "FROM scenarios s WHERE s.id = ?";
        return jdbc.query(sql, DETAIL_ROW_MAPPER, id).stream().findFirst();
    }

    @Override
    public boolean existsById(String id) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM scenarios WHERE id = ?", Integer.class, id);
        return count != null && count > 0;
    }

    @Override
    public Scenario save(Scenario scenario) {
        jdbc.update("""
                INSERT INTO scenarios (id, name, description, definition_json, created_at, updated_at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
                    definition_json = excluded.definition_json, updated_at = excluded.updated_at
                """,
                scenario.id(), scenario.name(), scenario.description(), writeJson(scenario.definition()),
                scenario.createdAt(), scenario.updatedAt());
        return findById(scenario.id()).orElseThrow(() -> new IllegalStateException("Scenario " + scenario.id() + " vanished immediately after being saved"));
    }

    @Override
    public boolean deleteById(String id) {
        return jdbc.update("DELETE FROM scenarios WHERE id = ?", id) > 0;
    }

    @Override
    public long storageSizeBytes() {
        try {
            return Files.size(Path.of(repository.dbFile()));
        } catch (IOException e) {
            return 0L;
        }
    }

    private String writeJson(JsonNode node) {
        try {
            return objectMapper.writeValueAsString(node == null ? objectMapper.nullNode() : node);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not serialize scenario definition", e));
        }
    }

    private static JsonNode readJson(ObjectMapper mapper, String text) {
        if (text == null) {
            return null;
        }
        try {
            return mapper.readTree(text);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not parse stored scenario JSON", e));
        }
    }

    private static RunOutcome lastRunOf(java.sql.ResultSet rs) throws java.sql.SQLException {
        int total = rs.getInt("last_total");
        if (rs.wasNull()) {
            return null;
        }
        return new RunOutcome(total, rs.getInt("last_passed"), rs.getInt("last_failed"), rs.getInt("last_errored"));
    }

    private final RowMapper<ScenarioSummary> SUMMARY_ROW_MAPPER = (rs, rowNum) -> new ScenarioSummary(
            rs.getString("id"), rs.getString("name"), rs.getString("description"),
            rs.getString("created_at"), rs.getString("updated_at"), lastRunOf(rs));

    private final RowMapper<Scenario> DETAIL_ROW_MAPPER = (rs, rowNum) -> new Scenario(
            rs.getString("id"), rs.getString("name"), rs.getString("description"),
            readJson(objectMapper, rs.getString("definition_json")),
            rs.getString("created_at"), rs.getString("updated_at"), lastRunOf(rs));
}
