package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fathy.alfred.backend.board.application.port.out.AskStorePort;
import com.fathy.alfred.backend.board.application.port.out.SnippetStorePort;
import com.fathy.alfred.backend.board.domain.model.Ask;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Snippet;
import com.fathy.alfred.backend.board.domain.model.SnippetShot;
import com.fathy.alfred.backend.board.domain.model.SnippetState;
import com.fathy.alfred.backend.board.domain.model.SnippetVersion;
import jakarta.annotation.PostConstruct;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Pages, versions, saved state and shots (specs/017) in board.db, through the board repository's own connection pool:
 * a card's pages, state and shots carry its id with ON DELETE CASCADE, so deleting a card takes them along.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.board", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteSnippetRepository implements SnippetStorePort, AskStorePort {

    private static final String COLUMNS = "id, owner_type, owner_id, project, card_id, cycle_id, name, kind, info, source, author, pinned, "
            + "position, version, created_at, updated_at, updated_by";
    private static final String LIST_COLUMNS = COLUMNS.replace("source", "NULL AS source");

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public SqliteSnippetRepository(SqliteBoardRepository board) {
        this.jdbc = board.jdbc();
        this.tx = board.tx();
    }

    @PostConstruct
    public void init() {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS snippets (id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, project TEXT NOT NULL,
                  card_id TEXT REFERENCES cards(id) ON DELETE CASCADE, cycle_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, info TEXT NOT NULL,
                  source TEXT NOT NULL, author TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
                  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_snippets_owner ON snippets(owner_type, owner_id, position)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_snippets_card ON snippets(card_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS snippet_versions (snippet_id TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
                  version INTEGER NOT NULL, name TEXT NOT NULL, info TEXT NOT NULL, source TEXT NOT NULL, author TEXT NOT NULL,
                  at INTEGER NOT NULL, PRIMARY KEY (snippet_id, version))""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS snippet_state (snippet_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
                  card_id TEXT REFERENCES cards(id) ON DELETE CASCADE, cycle_id TEXT, updated_by TEXT NOT NULL, at INTEGER NOT NULL,
                  PRIMARY KEY (snippet_id, key))""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_snippet_state_card ON snippet_state(card_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS snippet_state_history (id INTEGER PRIMARY KEY AUTOINCREMENT, snippet_id TEXT NOT NULL,
                  key TEXT NOT NULL, value TEXT NOT NULL, card_id TEXT REFERENCES cards(id) ON DELETE CASCADE, cycle_id TEXT,
                  updated_by TEXT NOT NULL, at INTEGER NOT NULL)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_snippet_state_history ON snippet_state_history(snippet_id, key, id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_snippet_state_history_card ON snippet_state_history(card_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS snippet_shots (snippet_id TEXT NOT NULL, version INTEGER NOT NULL, png BLOB NOT NULL,
                  console TEXT NOT NULL, card_id TEXT REFERENCES cards(id) ON DELETE CASCADE, cycle_id TEXT, at INTEGER NOT NULL,
                  PRIMARY KEY (snippet_id, version))""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_snippet_shots_card ON snippet_shots(card_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, project TEXT NOT NULL, cycle_id TEXT, card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
                  card_number INTEGER, snippet_id TEXT, kind TEXT NOT NULL, question TEXT NOT NULL, data TEXT, state TEXT NOT NULL, answer TEXT,
                  run_id TEXT, created_at INTEGER NOT NULL, answered_at INTEGER)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_asks_created ON asks(created_at)");
    }

    // ------------------------------------------------------------------------------------------------------------- asks

    @Override
    public void saveAsk(Ask a) {
        jdbc.update("INSERT INTO asks(id, project, cycle_id, card_id, card_number, snippet_id, kind, question, data, state, answer, run_id, created_at, "
                        + "answered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, answer = excluded.answer, "
                        + "answered_at = excluded.answered_at", a.id(), a.project(), a.cycleId(), a.cardId(), a.cardNumber(), a.snippetId(), a.kind().name(),
                a.question(), a.data(), a.state().name(), a.answer(), a.runId(), a.createdAt().toEpochMilli(),
                a.answeredAt() == null ? null : a.answeredAt().toEpochMilli());
    }

    @Override
    public Optional<Ask> findAsk(String id) {
        return jdbc.query("SELECT id, project, cycle_id, card_id, card_number, snippet_id, kind, question, data, state, answer, run_id, created_at, "
                + "answered_at FROM asks WHERE id = ?", (rs, n) -> new Ask(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4),
                rs.getObject(5) == null ? null : rs.getInt(5), rs.getString(6), Ask.Kind.valueOf(rs.getString(7)), rs.getString(8), rs.getString(9),
                Ask.State.valueOf(rs.getString(10)), rs.getString(11), rs.getString(12), Instant.ofEpochMilli(rs.getLong(13)),
                rs.getObject(14) == null ? null : Instant.ofEpochMilli(rs.getLong(14))), id).stream().findFirst();
    }

    @Override
    public int deleteAsksBefore(Instant before) {
        return jdbc.update("DELETE FROM asks WHERE created_at < ?", before.toEpochMilli());
    }

    // ------------------------------------------------------------------------------------------------------------ pages

    @Override
    public void insert(Snippet s) {
        tx.executeWithoutResult(status -> {
            jdbc.update("INSERT INTO snippets(" + COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", s.id(), s.ownerType().name(),
                    s.ownerId(), s.project(), s.cardId(), s.cycleId(), s.name(), s.kind().name(), s.info(), s.source(), s.author().name(),
                    s.pinned() ? 1 : 0, s.position(), s.version(), s.createdAt().toEpochMilli(), s.updatedAt().toEpochMilli(), s.updatedBy().name());
            version(s);
        });
    }

    @Override
    public void update(Snippet s, boolean newVersion) {
        tx.executeWithoutResult(status -> {
            jdbc.update("UPDATE snippets SET name = ?, info = ?, source = ?, pinned = ?, position = ?, version = ?, updated_at = ?, updated_by = ? "
                            + "WHERE id = ?", s.name(), s.info(), s.source(), s.pinned() ? 1 : 0, s.position(), s.version(),
                    s.updatedAt().toEpochMilli(), s.updatedBy().name(), s.id());
            if (newVersion) {
                version(s);
            }
        });
    }

    private void version(Snippet s) {
        jdbc.update("INSERT OR REPLACE INTO snippet_versions(snippet_id, version, name, info, source, author, at) VALUES (?,?,?,?,?,?,?)",
                s.id(), s.version(), s.name(), s.info(), s.source(), s.updatedBy().name(), s.updatedAt().toEpochMilli());
    }

    @Override
    public boolean delete(String id) {
        Boolean deleted = tx.execute(status -> {
            jdbc.update("DELETE FROM snippet_state WHERE snippet_id = ?", id);
            jdbc.update("DELETE FROM snippet_state_history WHERE snippet_id = ?", id);
            jdbc.update("DELETE FROM snippet_shots WHERE snippet_id = ?", id);
            return jdbc.update("DELETE FROM snippets WHERE id = ?", id) > 0;
        });
        return Boolean.TRUE.equals(deleted);
    }

    @Override
    public Optional<Snippet> find(String id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM snippets WHERE id = ?", SNIPPET, id).stream().findFirst();
    }

    @Override
    public List<Snippet> list(Snippet.Owner owner, String ownerId) {
        return jdbc.query("SELECT " + LIST_COLUMNS + " FROM snippets WHERE owner_type = ? AND owner_id = ? ORDER BY pinned DESC, position, created_at "
                + "LIMIT " + (Snippet.MAX_PER_OWNER * 2), SNIPPET, owner.name(), ownerId);
    }

    @Override
    public List<SnippetVersion> versions(String id) {
        return jdbc.query("SELECT snippet_id, version, name, info, NULL AS source, length(CAST(source AS BLOB)) AS size, author, at "
                + "FROM snippet_versions WHERE snippet_id = ? ORDER BY version DESC LIMIT 1000", VERSION, id);
    }

    @Override
    public Optional<SnippetVersion> version(String id, int version) {
        return jdbc.query("SELECT snippet_id, version, name, info, source, length(CAST(source AS BLOB)) AS size, author, at "
                + "FROM snippet_versions WHERE snippet_id = ? AND version = ?", VERSION, id, version).stream().findFirst();
    }

    // ------------------------------------------------------------------------------------------------------------ state

    @Override
    public List<SnippetState> state(String snippetId) {
        return jdbc.query("SELECT snippet_id, key, value, updated_by, at FROM snippet_state WHERE snippet_id = ? ORDER BY key LIMIT "
                + (SnippetState.MAX_KEYS + 1), STATE, snippetId);
    }

    @Override
    public Optional<SnippetState> state(String snippetId, String key) {
        return jdbc.query("SELECT snippet_id, key, value, updated_by, at FROM snippet_state WHERE snippet_id = ? AND key = ?", STATE, snippetId, key)
                .stream().findFirst();
    }

    @Override
    public void putState(SnippetState v, String cardId, String cycleId) {
        tx.executeWithoutResult(status -> {
            jdbc.update("INSERT INTO snippet_state_history(snippet_id, key, value, card_id, cycle_id, updated_by, at) "
                    + "SELECT snippet_id, key, value, card_id, cycle_id, updated_by, at FROM snippet_state WHERE snippet_id = ? AND key = ?",
                    v.snippetId(), v.key());
            jdbc.update("INSERT INTO snippet_state(snippet_id, key, value, card_id, cycle_id, updated_by, at) VALUES (?,?,?,?,?,?,?) "
                            + "ON CONFLICT(snippet_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, at = excluded.at",
                    v.snippetId(), v.key(), v.value(), cardId, cycleId, v.updatedBy().name(), v.at().toEpochMilli());
            jdbc.update("DELETE FROM snippet_state_history WHERE snippet_id = ? AND key = ? AND id NOT IN (SELECT id FROM snippet_state_history "
                    + "WHERE snippet_id = ? AND key = ? ORDER BY id DESC LIMIT ?)", v.snippetId(), v.key(), v.snippetId(), v.key(), SnippetState.HISTORY);
        });
    }

    @Override
    public boolean deleteState(String snippetId, String key) {
        return jdbc.update("DELETE FROM snippet_state WHERE snippet_id = ? AND key = ?", snippetId, key) > 0;
    }

    @Override
    public List<SnippetState> stateHistory(String snippetId, String key, int limit) {
        return jdbc.query("SELECT snippet_id, key, value, updated_by, at FROM snippet_state_history WHERE snippet_id = ? AND key = ? "
                + "ORDER BY id DESC LIMIT ?", STATE, snippetId, key, limit);
    }

    // ------------------------------------------------------------------------------------------------------------ shots

    @Override
    public void putShot(SnippetShot shot, String cardId, String cycleId) {
        tx.executeWithoutResult(status -> {
            jdbc.update("INSERT OR REPLACE INTO snippet_shots(snippet_id, version, png, console, card_id, cycle_id, at) VALUES (?,?,?,?,?,?,?)",
                    shot.snippetId(), shot.version(), shot.png(), shot.console(), cardId, cycleId, shot.at().toEpochMilli());
            jdbc.update("DELETE FROM snippet_shots WHERE snippet_id = ? AND version NOT IN (SELECT version FROM snippet_shots WHERE snippet_id = ? "
                    + "ORDER BY at DESC, version DESC LIMIT ?)", shot.snippetId(), shot.snippetId(), SnippetShot.KEEP);
        });
    }

    @Override
    public Optional<SnippetShot> shot(String snippetId) {
        return jdbc.query("SELECT snippet_id, version, png, console, at FROM snippet_shots WHERE snippet_id = ? ORDER BY at DESC, version DESC LIMIT 1",
                (rs, n) -> new SnippetShot(rs.getString(1), rs.getInt(2), rs.getBytes(3), rs.getString(4), Instant.ofEpochMilli(rs.getLong(5))),
                snippetId).stream().findFirst();
    }

    @Override
    public void cycleRemoved(String cycleId) {
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM snippet_state WHERE cycle_id = ? OR snippet_id IN (SELECT id FROM snippets WHERE cycle_id = ?)", cycleId, cycleId);
            jdbc.update("DELETE FROM snippet_state_history WHERE cycle_id = ? OR snippet_id IN (SELECT id FROM snippets WHERE cycle_id = ?)",
                    cycleId, cycleId);
            jdbc.update("DELETE FROM snippet_shots WHERE cycle_id = ? OR snippet_id IN (SELECT id FROM snippets WHERE cycle_id = ?)", cycleId, cycleId);
            jdbc.update("DELETE FROM snippets WHERE cycle_id = ?", cycleId);
        });
    }

    // ------------------------------------------------------------------------------------------------------------ rows

    private static final RowMapper<Snippet> SNIPPET = (rs, n) -> new Snippet(rs.getString("id"), Snippet.Owner.valueOf(rs.getString("owner_type")),
            rs.getString("owner_id"), rs.getString("project"), rs.getString("card_id"), rs.getString("cycle_id"), rs.getString("name"),
            Snippet.Kind.valueOf(rs.getString("kind")), rs.getString("info"), rs.getString("source"), Actor.valueOf(rs.getString("author")),
            rs.getInt("pinned") != 0, rs.getInt("position"), rs.getInt("version"), Instant.ofEpochMilli(rs.getLong("created_at")),
            Instant.ofEpochMilli(rs.getLong("updated_at")), Actor.valueOf(rs.getString("updated_by")));

    private static final RowMapper<SnippetVersion> VERSION = (rs, n) -> new SnippetVersion(rs.getString("snippet_id"), rs.getInt("version"),
            rs.getString("name"), rs.getString("info"), rs.getString("source"), rs.getInt("size"), Actor.valueOf(rs.getString("author")),
            Instant.ofEpochMilli(rs.getLong("at")));

    private static final RowMapper<SnippetState> STATE = (rs, n) -> new SnippetState(rs.getString("snippet_id"), rs.getString("key"),
            rs.getString("value"), Actor.valueOf(rs.getString("updated_by")), Instant.ofEpochMilli(rs.getLong("at")));
}
