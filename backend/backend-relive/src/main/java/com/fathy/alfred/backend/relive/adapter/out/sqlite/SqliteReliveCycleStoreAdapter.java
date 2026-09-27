package com.fathy.alfred.backend.relive.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.RunSummary;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Optional;

/**
 * Thin ReliveCycleStorePort implementation - all SQL/JDBC detail lives in
 * {@link SqliteReliveRepository}. The list query never touches {@code definition_json}
 * (constitution II) - {@code step_count}/{@code live_count}/{@code last_run_json} are their own
 * columns, kept in step by {@link #save}.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.relive", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteReliveCycleStoreAdapter implements ReliveCycleStorePort {

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public SqliteReliveCycleStoreAdapter(SqliteReliveRepository repository, ObjectMapper objectMapper) {
        this.jdbc = repository.jdbc();
        this.objectMapper = objectMapper;
    }

    @Override
    public List<ReliveCycleSummary> listSummaries() {
        return jdbc.query("""
                SELECT id, name, description, step_count, live_count, last_run_json, created_at, updated_at, is_transient
                FROM relive_cycles ORDER BY rowid DESC
                """, SUMMARY_ROW_MAPPER);
    }

    @Override
    public Optional<ReliveCycle> findById(String id) {
        return jdbc.query("SELECT definition_json FROM relive_cycles WHERE id = ?", (rs, n) -> readJson(rs.getString(1), ReliveCycle.class), id)
                .stream().findFirst();
    }

    @Override
    public boolean existsById(String id) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM relive_cycles WHERE id = ?", Integer.class, id);
        return count != null && count > 0;
    }

    @Override
    public ReliveCycle save(ReliveCycle cycle) {
        jdbc.update("""
                        INSERT INTO relive_cycles (id, name, description, definition_json, is_transient, step_count, live_count, last_run_json, created_at, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
                            definition_json = excluded.definition_json, is_transient = excluded.is_transient,
                            step_count = excluded.step_count, live_count = excluded.live_count,
                            last_run_json = excluded.last_run_json, updated_at = excluded.updated_at
                        """,
                cycle.id(), cycle.name(), cycle.description(), writeJson(cycle), cycle.isTransient() ? 1 : 0,
                cycle.steps() == null ? 0 : cycle.steps().size(),
                countLiveChildren(cycle), writeJson(cycle.lastRun()), cycle.createdAt(), cycle.updatedAt());
        return findById(cycle.id()).orElseThrow(() -> new IllegalStateException("Cycle " + cycle.id() + " vanished immediately after being saved"));
    }

    @Override
    public boolean deleteById(String id) {
        return jdbc.update("DELETE FROM relive_cycles WHERE id = ?", id) > 0;
    }

    @Override
    public void saveVersion(CycleVersion version, int keep) {
        jdbc.update("""
                        INSERT INTO relive_cycle_versions (cycle_id, version, saved_at, reason, definition_json)
                        VALUES (?,?,?,?,?)
                        ON CONFLICT(cycle_id, version) DO UPDATE SET saved_at = excluded.saved_at,
                            reason = excluded.reason, definition_json = excluded.definition_json
                        """,
                version.cycleId(), version.version(), version.savedAt(), version.reason(), writeJson(version.definition()));
        pruneVersions(version.cycleId(), keep);
    }

    @Override
    public List<CycleVersion> listVersions(String cycleId) {
        return jdbc.query("""
                SELECT cycle_id, version, saved_at, reason FROM relive_cycle_versions
                WHERE cycle_id = ? ORDER BY version DESC
                """, (rs, n) -> new CycleVersion(rs.getString("cycle_id"), rs.getInt("version"), rs.getString("saved_at"), rs.getString("reason"), null), cycleId);
    }

    @Override
    public Optional<CycleVersion> getVersion(String cycleId, int version) {
        return jdbc.query("""
                        SELECT cycle_id, version, saved_at, reason, definition_json FROM relive_cycle_versions
                        WHERE cycle_id = ? AND version = ?
                        """,
                        (rs, n) -> new CycleVersion(rs.getString("cycle_id"), rs.getInt("version"), rs.getString("saved_at"),
                                rs.getString("reason"), readJson(rs.getString("definition_json"), ReliveCycle.class)),
                        cycleId, version)
                .stream().findFirst();
    }

    @Override
    public void pruneVersions(String cycleId, int keep) {
        jdbc.update("""
                DELETE FROM relive_cycle_versions WHERE cycle_id = ? AND version NOT IN (
                    SELECT version FROM relive_cycle_versions WHERE cycle_id = ? ORDER BY version DESC LIMIT ?
                )
                """, cycleId, cycleId, keep);
    }

    /**
     * "LIVE count" for the list badge (FR-010a's UI, "N steps can reach a real system"). This
     * slice never interprets a call rule's actions (T007) - {@code modeOf()} is derived purely on
     * the frontend (`relive-call-rule.ts`) and by the proxy, from the same call rule document.
     * Rather than re-implement that derivation here (and risk it drifting out of step with the
     * real one), each outbound child's rule carries a display-only {@code "_liveHint"} boolean
     * next to its opaque body when the frontend saves a cycle (set by {@code applyMode()}); this
     * count is 0 until that hint is present, which only ever makes the list badge lag, never the
     * run itself (the proxy always reads the real actions, never this count).
     */
    private int countLiveChildren(ReliveCycle cycle) {
        if (cycle.steps() == null) {
            return 0;
        }
        return (int) cycle.steps().stream()
                .filter(s -> s.parentKey() != null && s.callRule() != null && s.callRule().rule() != null)
                .filter(s -> s.callRule().rule().path("_liveHint").asBoolean(false))
                .count();
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not serialize relive cycle data", e));
        }
    }

    private <T> T readJson(String text, Class<T> type) {
        if (text == null) {
            return null;
        }
        try {
            return objectMapper.readValue(text, type);
        } catch (Exception e) {
            throw new UncheckedIOException(new IOException("Could not parse stored relive JSON", e));
        }
    }

    private final RowMapper<ReliveCycleSummary> SUMMARY_ROW_MAPPER = (rs, rowNum) -> new ReliveCycleSummary(
            rs.getString("id"), rs.getString("name"), rs.getString("description"),
            rs.getInt("step_count"), rs.getInt("live_count"),
            readJson(rs.getString("last_run_json"), RunSummary.class),
            rs.getString("created_at"), rs.getString("updated_at"), rs.getInt("is_transient") != 0);
}
