package com.fathy.alfred.backend.teamboards.core.adapter.out.sqlite;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ChangeRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemQuery;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemsPage;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RevisionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SeedTarget;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.spi.model.FieldChange;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * teamboards.db (specs/027 data-model.md Part 2). Every list query selects named summary columns - never
 * {@code native_json}, which is written for the item drawer's "raw" view and the seed builder only. Search goes through
 * an FTS5 index of the title (and the id).
 */
@Component
public class SqliteTeamCacheRepository implements TeamCachePort {

    /** The columns a list reads: everything but the item's fields and raw JSON. */
    static final String SUMMARY = "conn, ext_id, type, custom_type, title, state, assignee, squad, sprint, area, url, rev, changed_at";

    @Value("${TEAMBOARDS_DB_FILE:/appdata/teamboards.db}")
    String dbFile = "/appdata/teamboards.db";

    private HikariDataSource dataSource;
    private JdbcTemplate jdbc;
    private TransactionTemplate tx;
    private final ObjectMapper json = new ObjectMapper();

    public SqliteTeamCacheRepository() {
    }

    /** For tests: a database at {@code file}, opened at once. */
    public SqliteTeamCacheRepository(Path file) {
        this.dbFile = file.toString();
        init();
    }

    @PostConstruct
    void init() {
        Path path = Path.of(dbFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Could not create the folder for " + dbFile, e);
        }
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:sqlite:" + path + "?transaction_mode=IMMEDIATE&foreign_keys=true");
        config.setMaximumPoolSize(4);
        config.setPoolName("teamboards-sqlite-pool");
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;");
        dataSource = new HikariDataSource(config);
        jdbc = new JdbcTemplate(dataSource);
        tx = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        schema();
        // fail at start, not at the first refresh, when the volume is read-only
        jdbc.update("INSERT OR REPLACE INTO meta(key, value) VALUES ('opened', ?)", String.valueOf(System.currentTimeMillis()));
    }

    @PreDestroy
    public void close() {
        if (dataSource != null) {
            dataSource.close();
        }
    }

    private void schema() {
        for (String ddl : List.of(
                "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
                """
                CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
                  scope_json TEXT NOT NULL, fetched_at INTEGER, fetched_by TEXT, seen_at INTEGER, created_at INTEGER NOT NULL)""",
                """
                CREATE TABLE IF NOT EXISTS items (conn TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, ext_id TEXT NOT NULL,
                  type TEXT NOT NULL, custom_type INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, state TEXT, assignee TEXT, squad TEXT,
                  sprint TEXT, area TEXT, url TEXT NOT NULL, rev INTEGER NOT NULL, changed_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
                  native_json TEXT NOT NULL, PRIMARY KEY (conn, ext_id))""",
                "CREATE INDEX IF NOT EXISTS idx_items_list ON items(conn, changed_at DESC)",
                "CREATE INDEX IF NOT EXISTS idx_items_squad ON items(conn, squad, state)",
                "CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(conn UNINDEXED, ext_id, title)",
                "CREATE TABLE IF NOT EXISTS item_fields (conn TEXT NOT NULL, ext_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (conn, ext_id, key))",
                """
                CREATE TABLE IF NOT EXISTS revisions (conn TEXT NOT NULL, ext_id TEXT NOT NULL, rev INTEGER NOT NULL, by_name TEXT, at INTEGER NOT NULL,
                  changes_json TEXT NOT NULL, PRIMARY KEY (conn, ext_id, rev))""",
                "CREATE INDEX IF NOT EXISTS idx_revisions_at ON revisions(at)",
                "CREATE TABLE IF NOT EXISTS links (conn TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (conn, from_id, to_id, kind))",
                "CREATE TABLE IF NOT EXISTS people (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, PRIMARY KEY (conn, ext_id))",
                """
                CREATE TABLE IF NOT EXISTS squads (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, project TEXT,
                  alfred_project TEXT, alfred_team TEXT, PRIMARY KEY (conn, ext_id))""",
                "CREATE TABLE IF NOT EXISTS squad_members (conn TEXT NOT NULL, squad TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY (conn, squad, person))",
                """
                CREATE TABLE IF NOT EXISTS boards (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, project TEXT, team TEXT,
                  columns_json TEXT, PRIMARY KEY (conn, ext_id))""",
                """
                CREATE TABLE IF NOT EXISTS sprints (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, team TEXT, starts INTEGER, ends INTEGER,
                  PRIMARY KEY (conn, ext_id))""",
                """
                CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, ext_id TEXT NOT NULL, rev INTEGER NOT NULL,
                  by_name TEXT, squad TEXT, at INTEGER NOT NULL, summary TEXT NOT NULL)""",
                "CREATE INDEX IF NOT EXISTS idx_changes ON changes(conn, at DESC)",
                """
                CREATE TABLE IF NOT EXISTS mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, kind TEXT NOT NULL,
                  ext_value TEXT NOT NULL, alfred_project TEXT NOT NULL, alfred_board TEXT, UNIQUE (conn, kind, ext_value))""",
                """
                CREATE TABLE IF NOT EXISTS field_maps (conn TEXT NOT NULL, item_type TEXT NOT NULL, field TEXT NOT NULL, target TEXT NOT NULL,
                  PRIMARY KEY (conn, item_type, field))""",
                """
                CREATE TABLE IF NOT EXISTS board_links (alfred_board TEXT PRIMARY KEY, conn TEXT NOT NULL, ext_id TEXT NOT NULL,
                  snapshot_json TEXT NOT NULL, seen_rev INTEGER NOT NULL, UNIQUE (conn, ext_id))""",
                """
                CREATE TABLE IF NOT EXISTS start_requests (conn TEXT NOT NULL, ext_id TEXT NOT NULL, alfred_board_target TEXT NOT NULL,
                  chat_message_id INTEGER, state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (conn, ext_id))""",
                """
                CREATE TABLE IF NOT EXISTS pending_attachments (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
                  size INTEGER NOT NULL, data BLOB NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (conn, ext_id, name))""")) {
            jdbc.execute(ddl);
        }
    }

    JdbcTemplate jdbc() {
        return jdbc;
    }

    TransactionTemplate tx() {
        return tx;
    }

    private static Long millis(Instant i) {
        return i == null ? null : i.toEpochMilli();
    }

    private static Instant instant(java.sql.ResultSet rs, int col) throws java.sql.SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : Instant.ofEpochMilli(v);
    }

    private String write(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private <T> T read(String s, TypeReference<T> type, T fallback) {
        if (s == null || s.isBlank()) {
            return fallback;
        }
        try {
            return json.readValue(s, type);
        } catch (IOException e) {
            return fallback;
        }
    }

    // ------------------------------------------------------------------------------------------------------ connections

    private final RowMapper<StoredConnection> connectionRow = (rs, n) -> new StoredConnection(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getString(4), read(rs.getString(5), new TypeReference<Scope>() { }, new Scope(List.of(), List.of())), instant(rs, 6),
            rs.getString(7), instant(rs, 8), instant(rs, 9));

    private static final String CONNECTION = "SELECT id, kind, name, base_url, scope_json, fetched_at, fetched_by, seen_at, created_at FROM connections";

    @Override
    public List<StoredConnection> connections() {
        return jdbc.query(CONNECTION + " ORDER BY created_at", connectionRow);
    }

    @Override
    public Optional<StoredConnection> connection(String id) {
        return jdbc.query(CONNECTION + " WHERE id = ?", connectionRow, id).stream().findFirst();
    }

    @Override
    public void putConnection(StoredConnection c) {
        jdbc.update("""
                INSERT INTO connections(id, kind, name, base_url, scope_json, fetched_at, fetched_by, seen_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, scope_json = excluded.scope_json, fetched_at = excluded.fetched_at,
                  fetched_by = excluded.fetched_by, seen_at = excluded.seen_at""",
                c.id(), c.kind(), c.name(), c.baseUrl(), write(c.scope()), millis(c.fetchedAt()), c.fetchedBy(), millis(c.seenAt()),
                millis(c.createdAt()));
    }

    @Override
    public boolean deleteConnection(String id) {
        return Boolean.TRUE.equals(tx.execute(s -> {
            for (String table : List.of("items_fts", "item_fields", "revisions", "links", "people", "squads", "squad_members", "boards", "sprints",
                    "changes", "mappings", "field_maps", "start_requests", "pending_attachments")) {
                jdbc.update("DELETE FROM " + table + " WHERE conn = ?", id);
            }
            jdbc.update("DELETE FROM board_links WHERE conn = ?", id);
            return jdbc.update("DELETE FROM connections WHERE id = ?", id) > 0; // items go by ON DELETE CASCADE
        }));
    }

    @Override
    public void markFetched(String id, Instant at, String by, Scope scopeUsed) {
        jdbc.update("UPDATE connections SET fetched_at = ?, fetched_by = ? WHERE id = ? AND scope_json = ?", millis(at), by, id, write(scopeUsed));
    }

    @Override
    public void rescope(String id, String name, Scope scope, boolean refetch) {
        jdbc.update("UPDATE connections SET name = ?, scope_json = ?" + (refetch ? ", fetched_at = NULL" : "") + " WHERE id = ?", name, write(scope), id);
    }

    @Override
    public void markSeen(String id, Instant at) {
        // the newest change's own time too: provider clocks run ahead of this one, and what was shown must not stay "new"
        jdbc.update("UPDATE connections SET seen_at = MAX(?, COALESCE((SELECT MAX(at) FROM changes WHERE conn = ?), 0)) WHERE id = ?", millis(at), id, id);
    }

    @Override
    public int changesAfter(String conn, Instant after) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM changes WHERE conn = ? AND at > ?", Integer.class, conn, after == null ? -1L : after.toEpochMilli());
        return n == null ? 0 : n;
    }

    // ---------------------------------------------------------------------------------------------------------- items

    private static String marks(int n) {
        return String.join(",", Collections.nCopies(n, "?"));
    }

    @Override
    public Map<String, Integer> revs(String conn, List<String> extIds) {
        Map<String, Integer> out = new HashMap<>();
        for (int i = 0; i < extIds.size(); i += 500) {
            List<String> chunk = extIds.subList(i, Math.min(extIds.size(), i + 500));
            List<Object> args = new ArrayList<>();
            args.add(conn);
            args.addAll(chunk);
            jdbc.query("SELECT ext_id, rev FROM items WHERE conn = ? AND ext_id IN (" + marks(chunk.size()) + ")",
                    rs -> { out.put(rs.getString(1), rs.getInt(2)); }, args.toArray());
        }
        return out;
    }

    private final RowMapper<ItemSummary> summaryRow = (rs, n) -> new ItemSummary(rs.getString(1), rs.getString(2), rs.getString(3), rs.getInt(4) == 1,
            rs.getString(5), rs.getString(6), rs.getString(7), rs.getString(8), rs.getString(9), rs.getString(10), rs.getString(11), rs.getInt(12),
            instant(rs, 13));

    @Override
    public Optional<ItemSummary> summary(String conn, String extId) {
        return jdbc.query("SELECT " + SUMMARY + " FROM items WHERE conn = ? AND ext_id = ?", summaryRow, conn, extId).stream().findFirst();
    }

    @Override
    public void upsertItems(String conn, List<Item> items, Instant fetchedAt) {
        tx.executeWithoutResult(s -> {
            for (Item i : items) {
                jdbc.update("""
                        INSERT INTO items(conn, ext_id, type, custom_type, title, state, assignee, squad, sprint, area, url, rev, changed_at, fetched_at, native_json)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(conn, ext_id) DO UPDATE SET type = excluded.type, custom_type = excluded.custom_type, title = excluded.title,
                          state = excluded.state, assignee = excluded.assignee, squad = excluded.squad, sprint = excluded.sprint, area = excluded.area,
                          url = excluded.url, rev = excluded.rev, changed_at = excluded.changed_at, fetched_at = excluded.fetched_at,
                          native_json = excluded.native_json""",
                        conn, i.extId(), i.type() == null ? "Item" : i.type(), i.customType() ? 1 : 0, i.title() == null ? "" : i.title(), i.state(),
                        i.assignee(), i.squad(), i.sprint(), i.area(), i.url() == null ? "" : i.url().toString(), i.rev(),
                        millis(i.changedAt() == null ? fetchedAt : i.changedAt()), millis(fetchedAt), i.nativeJson() == null ? "{}" : i.nativeJson());
                jdbc.update("DELETE FROM item_fields WHERE conn = ? AND ext_id = ?", conn, i.extId());
                for (Map.Entry<String, String> f : i.fields().entrySet()) {
                    jdbc.update("INSERT INTO item_fields(conn, ext_id, key, value) VALUES (?,?,?,?)", conn, i.extId(), f.getKey(), f.getValue());
                }
                jdbc.update("DELETE FROM links WHERE conn = ? AND from_id = ?", conn, i.extId());
                for (Link l : i.links()) {
                    jdbc.update("INSERT OR IGNORE INTO links(conn, from_id, to_id, kind) VALUES (?,?,?,?)", conn, i.extId(), l.toId(), l.kind());
                }
                // the FTS row shares the item's rowid: replacing it is one indexed delete, not a scan of the FTS table
                Long rowid = jdbc.queryForObject("SELECT rowid FROM items WHERE conn = ? AND ext_id = ?", Long.class, conn, i.extId());
                jdbc.update("DELETE FROM items_fts WHERE rowid = ?", rowid);
                jdbc.update("INSERT INTO items_fts(rowid, conn, ext_id, title) VALUES (?,?,?,?)", rowid, conn, i.extId(), i.title() == null ? "" : i.title());
            }
        });
    }

    /** "refund vouch" -> "refund"* "vouch"*: every word must match the start of a word, quotes doubled. */
    static String ftsQuery(String q) {
        List<String> words = new ArrayList<>();
        for (String w : q.strip().split("\\s+")) {
            String clean = w.replace("\"", "");
            if (!clean.isEmpty()) {
                words.add("\"" + clean + "\"*");
            }
        }
        return String.join(" ", words);
    }

    @Override
    public ItemsPage items(ItemQuery q) {
        StringBuilder where = new StringBuilder(" WHERE conn = ?");
        List<Object> args = new ArrayList<>();
        args.add(q.conn());
        if (q.q() != null && !q.q().isBlank()) {
            String fts = ftsQuery(q.q());
            if (!fts.isEmpty()) {
                where.append(" AND rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)");
                args.add(fts);
            }
        }
        for (String[] f : new String[][]{{"type", q.type()}, {"squad", q.squad()}, {"state", q.state()}, {"assignee", q.assignee()}, {"sprint", q.sprint()}}) {
            if (f[1] != null && !f[1].isBlank()) {
                where.append(" AND ").append(f[0]).append(" = ?");
                args.add(f[1]);
            }
        }
        Integer total = jdbc.queryForObject("SELECT COUNT(*) FROM items" + where, Integer.class, args.toArray());
        List<Object> page = new ArrayList<>(args);
        page.add(q.limit());
        page.add(q.offset());
        List<ItemSummary> rows = jdbc.query("SELECT " + SUMMARY + " FROM items" + where + " ORDER BY changed_at DESC, ext_id LIMIT ? OFFSET ?",
                summaryRow, page.toArray());
        return new ItemsPage(rows, total == null ? 0 : total);
    }

    @Override
    public Map<String, String> fields(String conn, String extId) {
        Map<String, String> out = new LinkedHashMap<>();
        jdbc.query("SELECT key, value FROM item_fields WHERE conn = ? AND ext_id = ? ORDER BY key", rs -> { out.put(rs.getString(1), rs.getString(2)); },
                conn, extId);
        return out;
    }

    @Override
    public List<Link> links(String conn, String extId) {
        return jdbc.query("SELECT to_id, kind FROM links WHERE conn = ? AND from_id = ? ORDER BY kind, to_id", (rs, n) -> new Link(rs.getString(1),
                rs.getString(2)), conn, extId);
    }

    /** The raw item, for the drawer's "raw" view and the seed builder - never a list. */
    @Override
    public Optional<String> nativeJson(String conn, String extId) {
        return jdbc.queryForList("SELECT native_json FROM items WHERE conn = ? AND ext_id = ?", String.class, conn, extId).stream().findFirst();
    }

    // ------------------------------------------------------------------------------------------- revisions and changes

    @Override
    public List<RevisionRow> revisions(String conn, String extId) {
        return jdbc.query("SELECT rev, by_name, at, changes_json FROM revisions WHERE conn = ? AND ext_id = ? ORDER BY rev DESC",
                (rs, n) -> new RevisionRow(rs.getInt(1), rs.getString(2), instant(rs, 3),
                        read(rs.getString(4), new TypeReference<List<FieldChange>>() { }, List.of())), conn, extId);
    }

    @Override
    public void putRevisions(String conn, String extId, List<RevisionRow> revisions) {
        tx.executeWithoutResult(s -> {
            for (RevisionRow r : revisions) {
                jdbc.update("INSERT OR REPLACE INTO revisions(conn, ext_id, rev, by_name, at, changes_json) VALUES (?,?,?,?,?,?)", conn, extId, r.rev(),
                        r.by(), millis(r.at() == null ? Instant.EPOCH : r.at()), write(r.changes()));
            }
        });
    }

    @Override
    public void addChange(String conn, String extId, int rev, String by, String squad, Instant at, String summary) {
        jdbc.update("INSERT INTO changes(conn, ext_id, rev, by_name, squad, at, summary) VALUES (?,?,?,?,?,?,?)", conn, extId, rev, by, squad,
                millis(at), summary.length() > 2000 ? summary.substring(0, 2000) : summary);
    }

    @Override
    public List<ChangeRow> changes(String conn, String squad, String person, Long after, int limit) {
        StringBuilder sql = new StringBuilder("""
                SELECT ch.id, ch.conn, ch.ext_id, ch.rev, ch.by_name, ch.squad, ch.at, ch.summary, i.title,
                  CASE WHEN c.seen_at IS NULL OR ch.at > c.seen_at THEN 1 ELSE 0 END
                FROM changes ch JOIN connections c ON c.id = ch.conn LEFT JOIN items i ON i.conn = ch.conn AND i.ext_id = ch.ext_id
                WHERE ch.conn = ?""");
        List<Object> args = new ArrayList<>();
        args.add(conn);
        if (squad != null) {
            sql.append(" AND ch.squad = ?");
            args.add(squad);
        }
        if (person != null) {
            sql.append(" AND (ch.by_name = ? OR i.assignee = ?)");
            args.add(person);
            args.add(person);
        }
        if (after != null) {
            sql.append(" AND ch.id < ?"); // paging older: "after" is the last id the page showed
            args.add(after);
        }
        sql.append(" ORDER BY ch.id DESC LIMIT ?"); // the order the cursor pages by: a provider clock can never skip a row
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> new ChangeRow(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getInt(4), rs.getString(5),
                rs.getString(6), instant(rs, 7), rs.getString(8), rs.getString(9), rs.getInt(10) == 1), args.toArray());
    }

    // ------------------------------------------------------------------------------- people, squads, boards, sprints

    @Override
    public void replacePeople(String conn, List<PersonRow> people) {
        tx.executeWithoutResult(s -> {
            jdbc.update("DELETE FROM people WHERE conn = ?", conn);
            for (PersonRow p : people) {
                jdbc.update("INSERT OR REPLACE INTO people(conn, ext_id, name, email) VALUES (?,?,?,?)", conn, p.extId(), p.name(), p.email());
            }
        });
    }

    @Override
    public List<PersonRow> people(String conn) {
        return jdbc.query("SELECT ext_id, name, email FROM people WHERE conn = ? ORDER BY name LIMIT 5000",
                (rs, n) -> new PersonRow(rs.getString(1), rs.getString(2), rs.getString(3)), conn);
    }

    @Override
    public void replaceSquads(String conn, List<SquadRow> squads) {
        tx.executeWithoutResult(s -> {
            // the Alfred mapping of a squad that is still there survives the refresh
            Map<String, String[]> mapped = new HashMap<>();
            jdbc.query("SELECT ext_id, alfred_project, alfred_team FROM squads WHERE conn = ?",
                    rs -> { mapped.put(rs.getString(1), new String[]{rs.getString(2), rs.getString(3)}); }, conn);
            jdbc.update("DELETE FROM squads WHERE conn = ?", conn);
            jdbc.update("DELETE FROM squad_members WHERE conn = ?", conn);
            for (SquadRow q : squads) {
                String[] m = mapped.getOrDefault(q.extId(), new String[2]);
                jdbc.update("INSERT OR REPLACE INTO squads(conn, ext_id, name, project, alfred_project, alfred_team) VALUES (?,?,?,?,?,?)", conn, q.extId(),
                        q.name(), q.project(), m[0], m[1]);
                for (String person : q.members()) {
                    jdbc.update("INSERT OR IGNORE INTO squad_members(conn, squad, person) VALUES (?,?,?)", conn, q.extId(), person);
                }
            }
        });
    }

    @Override
    public List<SquadRow> squads(String conn) {
        Map<String, List<String>> members = new HashMap<>();
        jdbc.query("SELECT squad, person FROM squad_members WHERE conn = ?", rs -> {
            members.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(rs.getString(2));
        }, conn);
        return jdbc.query("SELECT ext_id, name, project, alfred_project, alfred_team FROM squads WHERE conn = ? ORDER BY name",
                (rs, n) -> new SquadRow(conn, rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5),
                        members.getOrDefault(rs.getString(1), List.of())), conn);
    }

    @Override
    public boolean mapSquad(String conn, String extId, String alfredProject, String alfredTeam) {
        return jdbc.update("UPDATE squads SET alfred_project = ?, alfred_team = ? WHERE conn = ? AND ext_id = ?", alfredProject, alfredTeam, conn,
                extId) > 0;
    }

    @Override
    public void replaceBoards(String conn, List<BoardRow> boards) {
        tx.executeWithoutResult(s -> {
            jdbc.update("DELETE FROM boards WHERE conn = ?", conn);
            for (BoardRow b : boards) {
                jdbc.update("INSERT OR REPLACE INTO boards(conn, ext_id, name, project, team, columns_json) VALUES (?,?,?,?,?,?)", conn, b.extId(), b.name(),
                        b.project(), b.team(), write(b.columns()));
            }
        });
    }

    @Override
    public List<BoardRow> boards(String conn) {
        return jdbc.query("SELECT ext_id, name, project, team, columns_json FROM boards WHERE conn = ? ORDER BY project, team, name",
                (rs, n) -> new BoardRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        read(rs.getString(5), new TypeReference<List<String>>() { }, List.of())), conn);
    }

    @Override
    public void replaceSprints(String conn, List<SprintRow> sprints) {
        tx.executeWithoutResult(s -> {
            jdbc.update("DELETE FROM sprints WHERE conn = ?", conn);
            for (SprintRow r : sprints) {
                jdbc.update("INSERT OR REPLACE INTO sprints(conn, ext_id, name, team, starts, ends) VALUES (?,?,?,?,?,?)", conn, r.extId(), r.name(), r.team(),
                        millis(r.starts()), millis(r.ends()));
            }
        });
    }

    @Override
    public List<SprintRow> sprints(String conn) {
        return jdbc.query("SELECT ext_id, name, team, starts, ends FROM sprints WHERE conn = ? ORDER BY starts DESC, name",
                (rs, n) -> new SprintRow(rs.getString(1), rs.getString(2), rs.getString(3), instant(rs, 4), instant(rs, 5)), conn);
    }

    // ------------------------------------------------------------------------------------------ mappings, field maps

    private final RowMapper<MappingRow> mappingRow = (rs, n) -> new MappingRow(rs.getLong(1), rs.getString(2), MappingKind.valueOf(rs.getString(3)),
            rs.getString(4), rs.getString(5), rs.getString(6));

    @Override
    public List<MappingRow> mappings(String conn) {
        return jdbc.query("SELECT id, conn, kind, ext_value, alfred_project, alfred_board FROM mappings WHERE conn = ? ORDER BY kind, ext_value",
                mappingRow, conn);
    }

    @Override
    public MappingRow putMapping(String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard) {
        jdbc.update("""
                INSERT INTO mappings(conn, kind, ext_value, alfred_project, alfred_board) VALUES (?,?,?,?,?)
                ON CONFLICT(conn, kind, ext_value) DO UPDATE SET alfred_project = excluded.alfred_project, alfred_board = excluded.alfred_board""",
                conn, kind.name(), extValue, alfredProject, alfredBoard);
        return jdbc.query("SELECT id, conn, kind, ext_value, alfred_project, alfred_board FROM mappings WHERE conn = ? AND kind = ? AND ext_value = ?",
                mappingRow, conn, kind.name(), extValue).get(0);
    }

    @Override
    public boolean deleteMapping(String conn, long id) {
        return jdbc.update("DELETE FROM mappings WHERE conn = ? AND id = ?", conn, id) > 0;
    }

    @Override
    public List<FieldMapRow> fieldMaps(String conn) {
        return jdbc.query("SELECT conn, item_type, field, target FROM field_maps WHERE conn = ? ORDER BY item_type, field",
                (rs, n) -> new FieldMapRow(rs.getString(1), rs.getString(2), rs.getString(3), SeedTarget.valueOf(rs.getString(4))), conn);
    }

    @Override
    public void putFieldMap(FieldMapRow row) {
        jdbc.update("INSERT OR REPLACE INTO field_maps(conn, item_type, field, target) VALUES (?,?,?,?)", row.conn(), row.itemType(), row.field(),
                row.target().name());
    }

    @Override
    public boolean deleteFieldMap(String conn, String itemType, String field) {
        return jdbc.update("DELETE FROM field_maps WHERE conn = ? AND item_type = ? AND field = ?", conn, itemType, field) > 0;
    }

    // ---------------------------------------------------------------------------------------------------- board links

    private final RowMapper<BoardLinkRow> linkRow = (rs, n) -> new BoardLinkRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4),
            rs.getInt(5));

    @Override
    public Optional<BoardLinkRow> link(String alfredBoard) {
        return jdbc.query("SELECT alfred_board, conn, ext_id, snapshot_json, seen_rev FROM board_links WHERE alfred_board = ?", linkRow, alfredBoard)
                .stream().findFirst();
    }

    @Override
    public Optional<BoardLinkRow> linkOfItem(String conn, String extId) {
        return jdbc.query("SELECT alfred_board, conn, ext_id, snapshot_json, seen_rev FROM board_links WHERE conn = ? AND ext_id = ?", linkRow, conn,
                extId).stream().findFirst();
    }

    @Override
    public void putLink(BoardLinkRow row) {
        jdbc.update("INSERT OR REPLACE INTO board_links(alfred_board, conn, ext_id, snapshot_json, seen_rev) VALUES (?,?,?,?,?)", row.alfredBoard(),
                row.conn(), row.extId(), row.snapshotJson(), row.seenRev());
    }

    @Override
    public void markLinkSeen(String alfredBoard, int rev) {
        jdbc.update("UPDATE board_links SET seen_rev = ? WHERE alfred_board = ?", rev, alfredBoard);
    }

    @Override
    public boolean deleteLink(String alfredBoard) {
        return jdbc.update("DELETE FROM board_links WHERE alfred_board = ?", alfredBoard) > 0;
    }

    // ------------------------------------------------------------------------------------------------------- eviction

    @Override
    public int evict(int maxItems, int maxRevisions, int maxChangeRows, Instant changesOlderThan) {
        int removed = 0;
        removed += jdbc.update("DELETE FROM changes WHERE id IN (SELECT id FROM changes WHERE at < ? LIMIT 500)", millis(changesOlderThan));
        for (String conn : jdbc.queryForList("SELECT id FROM connections", String.class)) {
            removed += jdbc.update("DELETE FROM changes WHERE id IN (SELECT id FROM changes WHERE conn = ? ORDER BY at DESC, id DESC LIMIT 500 OFFSET ?)",
                    conn, maxChangeRows);
        }
        Integer revs = jdbc.queryForObject("SELECT COUNT(*) FROM revisions", Integer.class);
        if (revs != null && revs > maxRevisions) {
            removed += jdbc.update("DELETE FROM revisions WHERE rowid IN (SELECT rowid FROM revisions ORDER BY at LIMIT ?)", Math.min(500, revs - maxRevisions));
        }
        Integer items = jdbc.queryForObject("SELECT COUNT(*) FROM items", Integer.class);
        if (items != null && items > maxItems) {
            List<Map<String, Object>> old = jdbc.queryForList("""
                    SELECT rowid AS rid, conn, ext_id FROM items i WHERE NOT EXISTS (SELECT 1 FROM board_links l WHERE l.conn = i.conn AND l.ext_id = i.ext_id)
                    ORDER BY changed_at LIMIT ?""", Math.min(500, items - maxItems));
            int n = old.size();
            tx.executeWithoutResult(s -> {
                for (Map<String, Object> r : old) {
                    Object c = r.get("conn");
                    Object e = r.get("ext_id");
                    jdbc.update("DELETE FROM item_fields WHERE conn = ? AND ext_id = ?", c, e);
                    jdbc.update("DELETE FROM links WHERE conn = ? AND from_id = ?", c, e);
                    jdbc.update("DELETE FROM items_fts WHERE rowid = ?", r.get("rid"));
                    jdbc.update("DELETE FROM revisions WHERE conn = ? AND ext_id = ?", c, e);
                    jdbc.update("DELETE FROM items WHERE conn = ? AND ext_id = ?", c, e);
                }
            });
            removed += n;
        }
        jdbc.update("DELETE FROM pending_attachments WHERE fetched_at < ?", System.currentTimeMillis() - 24L * 3600 * 1000);
        return removed;
    }

    /** The whole file's size, for the storage budget. */
    public long sizeBytes() {
        try {
            return Files.size(Path.of(dbFile));
        } catch (IOException e) {
            return 0;
        }
    }

    // ------------------------------------------------------------------------------------------- starts, pending files

    @Override
    public Optional<StartRow> start(String conn, String extId) {
        return jdbc.query("SELECT conn, ext_id, alfred_board_target, chat_message_id, state, at FROM start_requests WHERE conn = ? AND ext_id = ?",
                (rs, n) -> new StartRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getObject(4) == null ? null : rs.getLong(4),
                        rs.getString(5), instant(rs, 6)), conn, extId).stream().findFirst();
    }

    @Override
    public void putStart(StartRow row) {
        jdbc.update("INSERT OR REPLACE INTO start_requests(conn, ext_id, alfred_board_target, chat_message_id, state, at) VALUES (?,?,?,?,?,?)",
                row.conn(), row.extId(), row.target(), row.chatMessageId(), row.state(), millis(row.at()));
    }

    @Override
    public boolean claimStart(StartRow row) {
        try {
            return jdbc.update("INSERT INTO start_requests(conn, ext_id, alfred_board_target, chat_message_id, state, at) VALUES (?,?,?,?,?,?)",
                    row.conn(), row.extId(), row.target(), row.chatMessageId(), row.state(), millis(row.at())) == 1;
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            return false;
        }
    }

    @Override
    public List<PendingFile> pending(String conn, String extId) {
        return jdbc.query("SELECT name, mime, size, data FROM pending_attachments WHERE conn = ? AND ext_id = ? ORDER BY name",
                (rs, n) -> new PendingFile(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getBytes(4)), conn, extId);
    }

    @Override
    public void deletePending(String conn, String extId, String name) {
        jdbc.update("DELETE FROM pending_attachments WHERE conn = ? AND ext_id = ? AND name = ?", conn, extId, name);
    }

    @Override
    public boolean insertLink(BoardLinkRow row) {
        try {
            return jdbc.update("INSERT INTO board_links(alfred_board, conn, ext_id, snapshot_json, seen_rev) VALUES (?,?,?,?,?)", row.alfredBoard(),
                    row.conn(), row.extId(), row.snapshotJson(), row.seenRev()) == 1;
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            return false;
        }
    }

    @Override
    public boolean deleteStart(String conn, String extId) {
        return jdbc.update("DELETE FROM start_requests WHERE conn = ? AND ext_id = ?", conn, extId) > 0;
    }

    @Override
    public void putPending(String conn, String extId, List<PendingFile> files) {
        long now = System.currentTimeMillis();
        tx.executeWithoutResult(s -> {
            for (PendingFile f : files) {
                jdbc.update("INSERT OR REPLACE INTO pending_attachments(conn, ext_id, name, mime, size, data, fetched_at) VALUES (?,?,?,?,?,?,?)",
                        conn, extId, f.name(), f.mime(), f.size(), f.data(), now);
            }
        });
    }

    @Override
    public List<PendingFile> takePending(String conn, String extId) {
        return tx.execute(s -> {
            List<PendingFile> out = jdbc.query("SELECT name, mime, size, data FROM pending_attachments WHERE conn = ? AND ext_id = ? ORDER BY name",
                    (rs, n) -> new PendingFile(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getBytes(4)), conn, extId);
            jdbc.update("DELETE FROM pending_attachments WHERE conn = ? AND ext_id = ?", conn, extId);
            return out;
        });
    }
}
