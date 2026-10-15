package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.RequirementStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The requirement check's tables (specs/018) in board.db, through the board repository's connection pool (the tables
 * are made there, so a cycle's deletion removes them in the same transaction). A row that cannot be read - JSON from a
 * later Alfred, an unknown result - is read as nothing / UNKNOWN, never an error.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.board", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteRequirementRepository implements RequirementStorePort {

    private static final TypeReference<Stored> STORED = new TypeReference<>() { };
    private static final String EVIDENCE_COLUMNS = "cycle_id, file_name, item_key, project, endpoint, evidence_json, updated_by, updated_at";

    /** What evidence_json holds. */
    private record Stored(List<EvidenceCheck> checks, String howTo) {
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final ObjectMapper json;

    public SqliteRequirementRepository(SqliteBoardRepository board, ObjectMapper json) {
        this.jdbc = board.jdbc();
        this.tx = board.tx();
        this.json = json;
    }

    private final RowMapper<ItemEvidence> evidenceRow = this::evidenceOf;

    private ItemEvidence evidenceOf(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        Stored s;
        try {
            s = json.readValue(rs.getString(6), STORED);
        } catch (JsonProcessingException | RuntimeException e) {
            s = new Stored(List.of(), "");
        }
        Actor by;
        try {
            by = Actor.valueOf(rs.getString(7));
        } catch (RuntimeException e) {
            by = Actor.CLAUDE;
        }
        return new ItemEvidence(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5),
                s.checks() == null ? List.of() : s.checks().stream().filter(c -> c != null && c.kind() != null).toList(),
                s.howTo(), by, Instant.ofEpochMilli(rs.getLong(8)));
    }

    @Override
    public List<ItemEvidence> evidence(String cycleId) {
        return jdbc.query("SELECT " + EVIDENCE_COLUMNS + " FROM item_evidence WHERE cycle_id = ? ORDER BY file_name, item_key LIMIT 2000",
                evidenceRow, cycleId);
    }

    @Override
    public Optional<ItemEvidence> evidence(String cycleId, String fileName, String itemKey) {
        return jdbc.query("SELECT " + EVIDENCE_COLUMNS + " FROM item_evidence WHERE cycle_id = ? AND file_name = ? AND item_key = ?",
                evidenceRow, cycleId, fileName, itemKey).stream().findFirst();
    }

    @Override
    public List<ItemEvidence> evidenceFor(String project, String endpoint) {
        return jdbc.query("SELECT " + EVIDENCE_COLUMNS + " FROM item_evidence WHERE project = ? AND endpoint = ? LIMIT 2000",
                evidenceRow, project, endpoint);
    }

    @Override
    public Set<String> watchedEndpoints() {
        return new LinkedHashSet<>(jdbc.query("SELECT DISTINCT project || char(10) || endpoint FROM item_evidence WHERE upper(endpoint) <> 'UI'",
                (rs, n) -> rs.getString(1)));
    }

    @Override
    public void putEvidence(ItemEvidence e) {
        String body;
        try {
            body = json.writeValueAsString(new Stored(e.checks(), e.howTo()));
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Evidence could not be written", ex);
        }
        tx.executeWithoutResult(status -> {
            jdbc.update("INSERT INTO item_evidence(" + EVIDENCE_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?) "
                            + "ON CONFLICT(cycle_id, file_name, item_key) DO UPDATE SET project = excluded.project, endpoint = excluded.endpoint, "
                            + "evidence_json = excluded.evidence_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
                    e.cycleId(), e.fileName(), e.itemKey(), e.project(), e.endpoint(), body, e.updatedBy().name(), e.updatedAt().toEpochMilli());
            // new checks: what calls showed under the old ones no longer says anything
            jdbc.update("DELETE FROM item_call_results WHERE cycle_id = ? AND file_name = ? AND item_key = ?", e.cycleId(), e.fileName(), e.itemKey());
        });
    }

    @Override
    public boolean deleteEvidence(String cycleId, String fileName, String itemKey) {
        Integer n = tx.execute(status -> {
            jdbc.update("DELETE FROM item_call_results WHERE cycle_id = ? AND file_name = ? AND item_key = ?", cycleId, fileName, itemKey);
            return jdbc.update("DELETE FROM item_evidence WHERE cycle_id = ? AND file_name = ? AND item_key = ?", cycleId, fileName, itemKey);
        });
        return n != null && n > 0;
    }

    @Override
    public Set<String> judgedCalls(String cycleId, String fileName, String itemKey) {
        return new HashSet<>(jdbc.query("SELECT call_id FROM item_call_results WHERE cycle_id = ? AND file_name = ? AND item_key = ?",
                (rs, n) -> rs.getString(1), cycleId, fileName, itemKey));
    }

    @Override
    public void putResults(String cycleId, String fileName, String itemKey, List<CallRow> rows) {
        if (rows.isEmpty()) {
            return;
        }
        tx.executeWithoutResult(status -> jdbc.batchUpdate("INSERT OR REPLACE INTO item_call_results(cycle_id, file_name, item_key, call_id, "
                        + "result, reason, at) VALUES (?,?,?,?,?,?,?)",
                rows.stream().map(r -> new Object[] {cycleId, fileName, itemKey, r.callId(), r.result().name(),
                        r.reason() == null ? null : r.reason().length() > 2000 ? r.reason().substring(0, 2000) : r.reason(),
                        r.at().toEpochMilli()}).toList()));
    }

    @Override
    public List<CallRow> results(String cycleId, String fileName, String itemKey, Instant since, int limit) {
        return jdbc.query("SELECT call_id, result, reason, at FROM item_call_results WHERE cycle_id = ? AND file_name = ? AND item_key = ? "
                        + "AND at >= ? ORDER BY at DESC, call_id LIMIT ?",
                (rs, n) -> new CallRow(rs.getString(1), CallResult.parse(rs.getString(2)), rs.getString(3), Instant.ofEpochMilli(rs.getLong(4))),
                cycleId, fileName, itemKey, since == null ? Long.MIN_VALUE : since.toEpochMilli(), limit);
    }

    @Override
    public Map<String, String> openedCards(String cycleId) {
        Map<String, String> out = new HashMap<>();
        jdbc.query("SELECT file_name || char(10) || item_key, card_id FROM item_cards WHERE cycle_id = ? LIMIT 2000",
                rs -> {
                    out.put(rs.getString(1), rs.getString(2));
                }, cycleId);
        return out;
    }

    @Override
    public void putOpenedCard(String cycleId, String fileName, String itemKey, String cardId) {
        jdbc.update("INSERT OR REPLACE INTO item_cards(cycle_id, file_name, item_key, card_id) VALUES (?,?,?,?)", cycleId, fileName, itemKey, cardId);
    }
}
