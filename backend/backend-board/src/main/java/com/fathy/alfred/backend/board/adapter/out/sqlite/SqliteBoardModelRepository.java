package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardActivity;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Boards, relations, card homes and board activity in board.db (specs/027 data-model.md). The tables are created by
 * {@link SqliteBoardRepository#init()} with the cards they filter, so a card query can join them from the first start.
 * Every list carries a LIMIT; relation lookups go through their indexes.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.board", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteBoardModelRepository implements BoardModelStorePort {

    private static final Logger log = LoggerFactory.getLogger(SqliteBoardModelRepository.class);
    private static final String BOARD_COLUMNS = "id, project, name, is_default, state, migrated_from, created_at, updated_at, updated_by";
    /** Seatbelt on relation lists: a board relates tens of cycles, not thousands. */
    private static final int RELATIONS = 2_000;
    /** At most this many oldest activity rows trimmed per insert, so one insert never becomes a long delete. */
    private static final int TRIM_PER_PASS = 200;

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final ObjectMapper json;

    public SqliteBoardModelRepository(SqliteBoardRepository board, ObjectMapper json) {
        this.jdbc = board.jdbc();
        this.tx = board.tx();
        this.json = json;
    }

    private static final RowMapper<Board> BOARD_ROW = (rs, n) -> new Board(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getInt(4) == 1, BoardState.valueOf(rs.getString(5)), rs.getString(6), Instant.ofEpochMilli(rs.getLong(7)),
            Instant.ofEpochMilli(rs.getLong(8)), Actor.valueOf(rs.getString(9)));

    @Override
    public Optional<Board> board(String id) {
        if (id == null || id.isBlank()) {
            return Optional.empty();
        }
        return jdbc.query("SELECT " + BOARD_COLUMNS + " FROM boards WHERE id = ?", BOARD_ROW, id).stream().findFirst();
    }

    @Override
    public List<Board> boards(String project, Set<BoardState> states, String q, int limit) {
        List<String> parts = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (project != null && !project.isBlank()) {
            parts.add("project = ?");
            args.add(project);
        }
        if (states != null && !states.isEmpty()) {
            parts.add("state IN (" + String.join(",", states.stream().map(s -> "?").toList()) + ")");
            states.forEach(s -> args.add(s.name()));
        }
        if (q != null && !q.isBlank()) {
            parts.add("name LIKE ? ESCAPE '\\'");
            args.add("%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
        }
        args.add(limit);
        String where = parts.isEmpty() ? "" : " WHERE " + String.join(" AND ", parts);
        // Default boards first, then the newest change.
        return jdbc.query("SELECT " + BOARD_COLUMNS + " FROM boards" + where + " ORDER BY is_default DESC, updated_at DESC LIMIT ?",
                BOARD_ROW, args.toArray());
    }

    @Override
    public void putBoard(Board b) {
        jdbc.update("""
                INSERT INTO boards(id, project, name, is_default, state, migrated_from, created_at, updated_at, updated_by)
                VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, state = excluded.state,
                  updated_at = excluded.updated_at, updated_by = excluded.updated_by
                """, b.id(), b.project(), b.name(), b.isDefault() ? 1 : 0, b.state().name(), b.migratedFrom(),
                b.createdAt().toEpochMilli(), b.updatedAt().toEpochMilli(), b.updatedBy().name());
    }

    @Override
    public void deleteBoard(String id, String moveCardsTo) {
        tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE cards SET board_id = ? WHERE board_id = ?", moveCardsTo, id);
            jdbc.update("DELETE FROM boards WHERE id = ?", id); // relations and activity cascade
        });
    }

    @Override
    public Map<String, Integer> cardCounts(Collection<String> boardIds) {
        Map<String, Integer> out = new HashMap<>();
        if (boardIds.isEmpty()) {
            return out;
        }
        List<String> ids = List.copyOf(boardIds);
        String marks = String.join(",", ids.stream().map(i -> "?").toList());
        jdbc.query("SELECT board_id, COUNT(*) FROM cards WHERE board_id IN (" + marks + ") GROUP BY board_id",
                rs -> {
                    out.put(rs.getString(1), rs.getInt(2));
                }, ids.toArray());
        return out;
    }

    // ------------------------------------------------------------------------------------------------ relations

    @Override
    public boolean relateCycle(String boardId, String cycleId, Actor by, Instant at) {
        return jdbc.update("INSERT OR IGNORE INTO board_cycles(board_id, cycle_id, related_by, related_at) VALUES (?,?,?,?)",
                boardId, cycleId, by.name(), at.toEpochMilli()) > 0;
    }

    @Override
    public boolean unrelateCycle(String boardId, String cycleId) {
        return jdbc.update("DELETE FROM board_cycles WHERE board_id = ? AND cycle_id = ?", boardId, cycleId) > 0;
    }

    @Override
    public List<String> cyclesOf(String boardId) {
        return jdbc.queryForList("SELECT cycle_id FROM board_cycles WHERE board_id = ? ORDER BY related_at LIMIT " + RELATIONS,
                String.class, boardId);
    }

    @Override
    public List<String> boardsOfCycle(String cycleId) {
        return jdbc.queryForList("SELECT board_id FROM board_cycles WHERE cycle_id = ? ORDER BY related_at LIMIT " + RELATIONS,
                String.class, cycleId);
    }

    @Override
    public boolean relateBoards(String a, String b) {
        if (a.equals(b)) {
            return false;
        }
        String lo = a.compareTo(b) < 0 ? a : b;
        String hi = a.compareTo(b) < 0 ? b : a;
        return jdbc.update("INSERT OR IGNORE INTO board_boards(a, b) VALUES (?,?)", lo, hi) > 0;
    }

    @Override
    public boolean unrelateBoards(String a, String b) {
        return jdbc.update("DELETE FROM board_boards WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)", a, b, b, a) > 0;
    }

    @Override
    public List<String> relatedBoards(String boardId) {
        return jdbc.queryForList("SELECT b FROM board_boards WHERE a = ? UNION SELECT a FROM board_boards WHERE b = ? LIMIT " + RELATIONS,
                String.class, boardId, boardId);
    }

    // ------------------------------------------------------------------------------------------------ card homes

    @Override
    public boolean setHome(String cardId, String boardId, Instant at, Actor by) {
        return jdbc.update("UPDATE cards SET board_id = ?, updated_at = ?, updated_by = ? WHERE id = ?", boardId, at.toEpochMilli(),
                by.name(), cardId) > 0;
    }

    @Override
    public boolean relateCardCycle(String cardId, String cycleId) {
        return jdbc.update("INSERT OR IGNORE INTO card_cycles(card_id, cycle_id) VALUES (?,?)", cardId, cycleId) > 0;
    }

    @Override
    public boolean unrelateCardCycle(String cardId, String cycleId) {
        return jdbc.update("DELETE FROM card_cycles WHERE card_id = ? AND cycle_id = ?", cardId, cycleId) > 0;
    }

    @Override
    public List<String> cardCycles(String cardId) {
        return jdbc.queryForList("SELECT cycle_id FROM card_cycles WHERE card_id = ? LIMIT " + RELATIONS, String.class, cardId);
    }

    @Override
    public void cycleGone(String cycleId) {
        tx.executeWithoutResult(s -> {
            jdbc.update("DELETE FROM board_cycles WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM card_cycles WHERE cycle_id = ?", cycleId);
            jdbc.update("UPDATE cards SET cycle_deleted = 1 WHERE cycle_id = ?", cycleId);
        });
    }

    // ------------------------------------------------------------------------------------------------ activity

    @Override
    public long addActivity(BoardActivity e, int keep) {
        Long id = tx.execute(s -> {
            jdbc.update("INSERT INTO board_activity(board_id, actor, kind, text, undo_json, at) VALUES (?,?,?,?,?,?)", e.boardId(),
                    e.actor().name(), e.kind().name(), e.text(), undoText(e.undo()), e.at().toEpochMilli());
            Long newId = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            // Retention (data-model.md): keep the newest {@code keep} rows of the board, trimming a bounded batch.
            jdbc.update("""
                    DELETE FROM board_activity WHERE id IN (SELECT id FROM board_activity WHERE board_id = ?
                      ORDER BY id DESC LIMIT ? OFFSET ?)
                    """, e.boardId(), TRIM_PER_PASS, Math.max(1, keep));
            return newId;
        });
        return id == null ? 0 : id;
    }

    private static final String ACTIVITY_COLUMNS = "id, board_id, actor, kind, text, undo_json, at, undone_at";

    private RowMapper<BoardActivity> activityRow() {
        return (rs, n) -> {
            long undone = rs.getLong(8);
            Instant undoneAt = rs.wasNull() ? null : Instant.ofEpochMilli(undone);
            return new BoardActivity(rs.getLong(1), rs.getString(2), Actor.valueOf(rs.getString(3)), BoardActivity.Kind.valueOf(rs.getString(4)),
                    rs.getString(5), undoOf(rs.getString(6)), Instant.ofEpochMilli(rs.getLong(7)), undoneAt);
        };
    }

    @Override
    public List<BoardActivity> activity(String boardId, long after, int limit) {
        // newest first; with a cursor, the oldest rows after it, so paging forward never skips any
        return jdbc.query("SELECT " + ACTIVITY_COLUMNS + " FROM board_activity WHERE board_id = ? AND id > ? ORDER BY id "
                + (after > 0 ? "ASC" : "DESC") + " LIMIT ?", activityRow(), boardId, after, limit);
    }

    @Override
    public Optional<BoardActivity> activityEntry(long id) {
        return jdbc.query("SELECT " + ACTIVITY_COLUMNS + " FROM board_activity WHERE id = ?", activityRow(), id).stream().findFirst();
    }

    @Override
    public boolean markUndone(long id, Instant at) {
        return jdbc.update("UPDATE board_activity SET undone_at = ? WHERE id = ? AND undone_at IS NULL", at.toEpochMilli(), id) == 1;
    }

    private String undoText(BoardActivity.Undo u) {
        if (u == null) {
            return null;
        }
        try {
            return json.writeValueAsString(u);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not write an undo record", e);
        }
    }

    private BoardActivity.Undo undoOf(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return json.readValue(s, BoardActivity.Undo.class);
        } catch (JsonProcessingException e) {
            log.warn("Unreadable board undo record: {}", e.getOriginalMessage());
            return null;
        }
    }

    // ------------------------------------------------------------------------------------------------ migration

    @Override
    public boolean done(String step) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM board_meta WHERE key = ?", Integer.class, step);
        return n != null && n > 0;
    }

    @Override
    public void markDone(String step) {
        jdbc.update("INSERT OR REPLACE INTO board_meta(key, value) VALUES (?, '1')", step);
    }

    @Override
    public List<CycleMention> mentionsInCycle(String cycleId) {
        // the board a mention is on: its card's home; a brief's or checklist mark's own task key; a chat message's board
        return jdbc.query("""
                SELECT m.call_id,
                  CASE WHEN m.card_id IS NOT NULL THEN c.board_id
                       WHEN m.owner_type = 'BRIEF' THEN m.owner_id
                       WHEN m.owner_type = 'CHECKLIST' AND instr(m.owner_id, '/') > 0 THEN substr(m.owner_id, 1, instr(m.owner_id, '/') - 1)
                       WHEN m.owner_type = 'CHAT' THEN (SELECT CASE WHEN ch.cycle_id = '' THEN 'default:' || ch.project ELSE ch.cycle_id END
                                                        FROM chat_messages ch WHERE ch.id = CAST(m.owner_id AS INTEGER))
                  END,
                  COALESCE(c.number, 0)
                FROM mentions m LEFT JOIN cards c ON c.id = m.card_id
                WHERE m.cycle_id = ? AND m.call_id IS NOT NULL LIMIT 100000
                """, (rs, n) -> new CycleMention(rs.getString(1), rs.getString(2), rs.getInt(3)), cycleId);
    }

    @Override
    public List<String> knownProjects() {
        return jdbc.queryForList("""
                SELECT project FROM cards UNION SELECT project FROM chat_messages UNION SELECT project FROM item_evidence
                UNION SELECT project FROM boards LIMIT 10000
                """, String.class).stream().filter(p -> p != null && !p.isBlank()).toList();
    }

    @Override
    public List<String> briefedTaskKeys() {
        return jdbc.queryForList("""
                SELECT cycle_id FROM cycle_briefs UNION SELECT cycle_id FROM spec_files UNION SELECT cycle_id FROM item_evidence
                UNION SELECT cycle_id FROM chat_messages WHERE cycle_id != '' LIMIT 10000
                """, String.class).stream().filter(k -> k != null && !k.isBlank()).toList();
    }

    @Override
    public Optional<String> projectOfTaskKey(String taskKey) {
        List<String> found = jdbc.queryForList("""
                SELECT project FROM (SELECT project, 1 AS o FROM cards WHERE cycle_id = ? AND project != ''
                  UNION ALL SELECT project, 2 FROM chat_messages WHERE cycle_id = ? AND project != ''
                  UNION ALL SELECT project, 3 FROM item_evidence WHERE cycle_id = ? AND project != '') ORDER BY o LIMIT 1
                """, String.class, taskKey, taskKey, taskKey);
        return found.stream().findFirst();
    }

    @Override
    public Map<String, List<String>> originCyclesByProject() {
        Map<String, List<String>> out = new LinkedHashMap<>();
        jdbc.query("SELECT DISTINCT project, cycle_id FROM cards WHERE cycle_id IS NOT NULL AND cycle_id != '' LIMIT 100000",
                rs -> {
                    out.computeIfAbsent(rs.getString(1), p -> new ArrayList<>()).add(rs.getString(2));
                });
        return out;
    }

    @Override
    public int homeCardsOfTaskKey(String taskKey, String project) {
        return jdbc.update("UPDATE cards SET board_id = ? WHERE cycle_id = ? AND project = ?", taskKey, taskKey, project);
    }
}
