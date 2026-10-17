package com.fathy.alfred.backend.teamboards.core.adapter.out.sqlite;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardBadge;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldDiff;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemCopyRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SeedTarget;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SyncRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TypeKindRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WatchRuleRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * teamboards.db, schema 2 (specs/028 data-model.md). A schema-1 file (027's fetch-everything cache) is upgraded on
 * open: the item cache, its history, the changes feed and the old board links are dropped and a one-time notice is
 * set; connections, mappings, field maps, the lists and Start rows stay.
 */
@Component
public class SqliteTeamCacheRepository implements TeamCachePort {

    static final String SCHEMA = "2";
    /** 027's tables that 028 drops (FR-017/018). */
    static final List<String> DROPPED = List.of("items_fts", "item_fields", "revisions", "links", "changes", "board_links", "items");

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
        // fail at start, not at the first write, when the volume is read-only
        jdbc.update("INSERT OR REPLACE INTO meta(key, value) VALUES ('opened', ?)", String.valueOf(System.currentTimeMillis()));
    }

    @PreDestroy
    public void close() {
        if (dataSource != null) {
            dataSource.close();
        }
    }

    private boolean tableExists(String name) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM sqlite_master WHERE name = ?", Integer.class, name);
        return n != null && n > 0;
    }

    private boolean columnExists(String table, String column) {
        return jdbc.queryForList("SELECT name FROM pragma_table_info(?)", String.class, table).contains(column);
    }

    private void schema() {
        jdbc.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
        String version = jdbc.queryForList("SELECT value FROM meta WHERE key = 'schema'", String.class).stream().findFirst().orElse(null);
        if (version == null && tableExists("items")) {
            // a 027 file: the item cache goes, nothing of it is migrated (028 decision); the user is told once
            tx.executeWithoutResult(s -> {
                for (String t : DROPPED) {
                    jdbc.execute("DROP TABLE IF EXISTS " + t);
                }
                jdbc.update("INSERT OR REPLACE INTO meta(key, value) VALUES ('upgrade-notice-028', '1')");
            });
        }
        for (String ddl : List.of(
                """
                CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
                  scope_json TEXT NOT NULL, fetched_at INTEGER, fetched_by TEXT, seen_at INTEGER, created_at INTEGER NOT NULL, lists_at INTEGER)""",
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
                CREATE TABLE IF NOT EXISTS item_states (conn TEXT NOT NULL, project TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
                  category TEXT, sort INTEGER NOT NULL, PRIMARY KEY (conn, project, type, name))""",
                "CREATE TABLE IF NOT EXISTS areas (conn TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (conn, path))",
                """
                CREATE TABLE IF NOT EXISTS mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, kind TEXT NOT NULL,
                  ext_value TEXT NOT NULL, alfred_project TEXT NOT NULL, alfred_board TEXT, UNIQUE (conn, kind, ext_value))""",
                """
                CREATE TABLE IF NOT EXISTS field_maps (conn TEXT NOT NULL, item_type TEXT NOT NULL, field TEXT NOT NULL, target TEXT NOT NULL,
                  PRIMARY KEY (conn, item_type, field))""",
                "CREATE TABLE IF NOT EXISTS type_kind_map (conn TEXT NOT NULL, type TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (conn, type))",
                """
                CREATE TABLE IF NOT EXISTS start_requests (conn TEXT NOT NULL, ext_id TEXT NOT NULL, alfred_board_target TEXT NOT NULL,
                  chat_message_id INTEGER, state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (conn, ext_id))""",
                """
                CREATE TABLE IF NOT EXISTS pending_attachments (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
                  size INTEGER NOT NULL, data BLOB NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (conn, ext_id, name))""",
                """
                CREATE TABLE IF NOT EXISTS board_items (board_id TEXT NOT NULL, conn TEXT NOT NULL, item TEXT NOT NULL, role TEXT NOT NULL,
                  relation TEXT NOT NULL, link_kind TEXT, parent_item TEXT, depth INTEGER NOT NULL DEFAULT 0, type TEXT, title TEXT, state TEXT,
                  state_category TEXT, rev INTEGER NOT NULL DEFAULT 0, left_tree_at INTEGER, added_at INTEGER NOT NULL, added_by TEXT,
                  PRIMARY KEY (board_id, conn, item))""",
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_board_main ON board_items(board_id) WHERE role = 'MAIN'",
                "CREATE INDEX IF NOT EXISTS idx_board_items_item ON board_items(conn, item)",
                """
                CREATE TABLE IF NOT EXISTS item_copies (conn TEXT NOT NULL, item TEXT NOT NULL, rev INTEGER NOT NULL, item_json TEXT NOT NULL,
                  comments_json TEXT, saved_at INTEGER NOT NULL, PRIMARY KEY (conn, item))""",
                """
                CREATE TABLE IF NOT EXISTS item_syncs (id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, item TEXT NOT NULL,
                  from_rev INTEGER NOT NULL, to_rev INTEGER NOT NULL, at INTEGER NOT NULL, diff_json TEXT NOT NULL, kept INTEGER NOT NULL DEFAULT 0)""",
                "CREATE INDEX IF NOT EXISTS idx_item_syncs ON item_syncs(conn, item, id DESC)",
                """
                CREATE TABLE IF NOT EXISTS card_links (card_id TEXT NOT NULL, board_id TEXT, conn TEXT NOT NULL, item TEXT NOT NULL,
                  linked_at INTEGER NOT NULL, linked_by TEXT, hyperlink INTEGER NOT NULL DEFAULT 0, tag INTEGER NOT NULL DEFAULT 0, comment_id TEXT,
                  PRIMARY KEY (card_id, conn, item))""",
                "CREATE INDEX IF NOT EXISTS idx_card_links_item ON card_links(conn, item)",
                "CREATE INDEX IF NOT EXISTS idx_card_links_board ON card_links(board_id)",
                """
                CREATE TABLE IF NOT EXISTS incoming (board_id TEXT NOT NULL, conn TEXT NOT NULL, item TEXT NOT NULL, source TEXT NOT NULL,
                  arrived_at INTEGER NOT NULL, rev INTEGER NOT NULL, type TEXT, title TEXT, match_card TEXT, match_score INTEGER,
                  proposal_action TEXT, proposal_card TEXT, proposal_reason TEXT, state TEXT NOT NULL, ignored_rev INTEGER, decided_at INTEGER,
                  PRIMARY KEY (board_id, conn, item))""",
                "CREATE INDEX IF NOT EXISTS idx_incoming_state ON incoming(board_id, state)",
                """
                CREATE TABLE IF NOT EXISTS watch_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, conn TEXT NOT NULL,
                  name TEXT NOT NULL, query_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_run_at INTEGER, last_source TEXT,
                  last_new INTEGER NOT NULL DEFAULT 0)""",
                "CREATE INDEX IF NOT EXISTS idx_watch_rules_board ON watch_rules(board_id)",
                """
                CREATE TABLE IF NOT EXISTS azure_writes (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, card_id TEXT, conn TEXT NOT NULL,
                  item TEXT, origin TEXT NOT NULL, asked_in TEXT, title TEXT NOT NULL, steps_json TEXT NOT NULL, state TEXT NOT NULL,
                  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT)""",
                "CREATE INDEX IF NOT EXISTS idx_azure_writes ON azure_writes(board_id, state)",
                """
                CREATE TABLE IF NOT EXISTS azure_write_files (write_id INTEGER NOT NULL, step INTEGER NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
                  bytes BLOB NOT NULL, PRIMARY KEY (write_id, step))""",
                """
                CREATE TABLE IF NOT EXISTS hook_settings (conn TEXT PRIMARY KEY, secret_hash TEXT, rotated_at INTEGER, last_ping_at INTEGER,
                  last_event TEXT, bad_pings INTEGER NOT NULL DEFAULT 0, public_address TEXT)""",
                "CREATE TABLE IF NOT EXISTS hook_waiting (conn TEXT NOT NULL, item TEXT NOT NULL, event TEXT, at INTEGER NOT NULL, PRIMARY KEY (conn, item))",
                "CREATE TABLE IF NOT EXISTS me_override (conn TEXT PRIMARY KEY, person TEXT NOT NULL, token_owner TEXT, at INTEGER NOT NULL)")) {
            jdbc.execute(ddl);
        }
        if (!columnExists("connections", "lists_at")) {
            jdbc.execute("ALTER TABLE connections ADD COLUMN lists_at INTEGER");
        }
        jdbc.update("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)", SCHEMA);
    }

    JdbcTemplate jdbc() {
        return jdbc;
    }

    private static Long millis(Instant i) {
        return i == null ? null : i.toEpochMilli();
    }

    private static Instant instant(java.sql.ResultSet rs, int col) throws java.sql.SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : Instant.ofEpochMilli(v);
    }

    private static Integer intOrNull(java.sql.ResultSet rs, int col) throws java.sql.SQLException {
        int v = rs.getInt(col);
        return rs.wasNull() ? null : v;
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

    private static String marks(int n) {
        return String.join(",", Collections.nCopies(n, "?"));
    }

    // ------------------------------------------------------------------------------------------------------ connections

    private final RowMapper<StoredConnection> connectionRow = (rs, n) -> new StoredConnection(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getString(4), read(rs.getString(5), new TypeReference<Scope>() { }, new Scope(List.of(), List.of())), instant(rs, 6), instant(rs, 7));

    private static final String CONNECTION = "SELECT id, kind, name, base_url, scope_json, lists_at, created_at FROM connections";

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
                INSERT INTO connections(id, kind, name, base_url, scope_json, lists_at, created_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, scope_json = excluded.scope_json, lists_at = excluded.lists_at""",
                c.id(), c.kind(), c.name(), c.baseUrl(), write(c.scope()), millis(c.listsAt()), millis(c.createdAt()));
    }

    @Override
    public boolean deleteConnection(String id) {
        return Boolean.TRUE.equals(tx.execute(s -> {
            for (String table : List.of("people", "squads", "squad_members", "boards", "sprints", "item_states", "areas", "mappings", "field_maps",
                    "type_kind_map", "start_requests", "pending_attachments", "board_items", "item_copies", "item_syncs", "card_links", "incoming",
                    "watch_rules", "hook_waiting")) {
                jdbc.update("DELETE FROM " + table + " WHERE conn = ?", id);
            }
            jdbc.update("DELETE FROM azure_write_files WHERE write_id IN (SELECT id FROM azure_writes WHERE conn = ?)", id);
            jdbc.update("DELETE FROM azure_writes WHERE conn = ?", id);
            jdbc.update("DELETE FROM hook_settings WHERE conn = ?", id);
            jdbc.update("DELETE FROM me_override WHERE conn = ?", id);
            return jdbc.update("DELETE FROM connections WHERE id = ?", id) > 0;
        }));
    }

    @Override
    public void rescope(String id, String name, Scope scope) {
        jdbc.update("UPDATE connections SET name = ?, scope_json = ? WHERE id = ?", name, write(scope), id);
    }

    @Override
    public void markLists(String id, Instant at) {
        jdbc.update("UPDATE connections SET lists_at = ? WHERE id = ?", millis(at), id);
    }

    @Override
    public boolean upgradeNotice() {
        return jdbc.queryForList("SELECT value FROM meta WHERE key = 'upgrade-notice-028'", String.class).contains("1");
    }

    @Override
    public void dismissUpgradeNotice() {
        jdbc.update("DELETE FROM meta WHERE key = 'upgrade-notice-028'");
    }

    // --------------------------------------------------------------------------------------------------- filter lists

    @Override
    public void upsertPeople(String conn, List<PersonRow> people) {
        tx.executeWithoutResult(s -> {
            for (PersonRow p : people) {
                if (p.extId() == null || p.extId().isBlank()) {
                    continue;
                }
                jdbc.update("""
                        INSERT INTO people(conn, ext_id, name, email) VALUES (?,?,?,?)
                        ON CONFLICT(conn, ext_id) DO UPDATE SET name = excluded.name, email = COALESCE(excluded.email, people.email)""",
                        conn, p.extId(), p.name() == null || p.name().isBlank() ? p.extId() : p.name(), p.email());
            }
        });
    }

    @Override
    public List<PersonRow> people(String conn) {
        return jdbc.query("SELECT ext_id, name, email FROM people WHERE conn = ? ORDER BY name LIMIT 5000",
                (rs, n) -> new PersonRow(rs.getString(1), rs.getString(2), rs.getString(3)), conn);
    }

    @Override
    public Optional<PersonRow> person(String conn, String extId) {
        return jdbc.query("SELECT ext_id, name, email FROM people WHERE conn = ? AND (ext_id = ? OR lower(email) = lower(?))",
                (rs, n) -> new PersonRow(rs.getString(1), rs.getString(2), rs.getString(3)), conn, extId, extId).stream().findFirst();
    }

    @Override
    public List<String> unknownPeople(String conn, Collection<String> ids) {
        List<String> out = new ArrayList<>();
        for (String id : ids) {
            if (id != null && !id.isBlank() && person(conn, id).isEmpty()) {
                out.add(id);
            }
        }
        return out;
    }

    @Override
    public void replaceSquads(String conn, List<SquadIn> squads) {
        tx.executeWithoutResult(s -> {
            // the Alfred mapping of a squad that is still there survives the refresh
            Map<String, String[]> mapped = new HashMap<>();
            jdbc.query("SELECT ext_id, alfred_project, alfred_team FROM squads WHERE conn = ?",
                    rs -> { mapped.put(rs.getString(1), new String[]{rs.getString(2), rs.getString(3)}); }, conn);
            jdbc.update("DELETE FROM squads WHERE conn = ?", conn);
            jdbc.update("DELETE FROM squad_members WHERE conn = ?", conn);
            for (SquadIn q : squads) {
                String[] m = mapped.getOrDefault(q.extId(), new String[2]);
                jdbc.update("INSERT OR REPLACE INTO squads(conn, ext_id, name, project, alfred_project, alfred_team) VALUES (?,?,?,?,?,?)", conn, q.extId(),
                        q.name(), q.project(), m[0], m[1]);
                for (String person : q.memberIds()) {
                    jdbc.update("INSERT OR IGNORE INTO squad_members(conn, squad, person) VALUES (?,?,?)", conn, q.extId(), person);
                }
            }
        });
    }

    @Override
    public List<SquadRow> squads(String conn) {
        Map<String, List<PersonRow>> members = new HashMap<>();
        // members as people: a person not resolved yet shows its id as its name until the lists are read again
        jdbc.query("""
                SELECT m.squad, m.person, COALESCE(p.name, m.person), p.email FROM squad_members m
                LEFT JOIN people p ON p.conn = m.conn AND p.ext_id = m.person WHERE m.conn = ? ORDER BY 3""", rs -> {
            members.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(new PersonRow(rs.getString(2), rs.getString(3), rs.getString(4)));
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

    @Override
    public void replaceStates(String conn, List<StateRow> states) {
        tx.executeWithoutResult(s -> {
            jdbc.update("DELETE FROM item_states WHERE conn = ?", conn);
            int i = 0;
            for (StateRow r : states) {
                jdbc.update("INSERT OR REPLACE INTO item_states(conn, project, type, name, category, sort) VALUES (?,?,?,?,?,?)", conn,
                        r.project() == null ? "" : r.project(), r.type(), r.name(), r.category(), i++);
            }
        });
    }

    @Override
    public List<StateRow> states(String conn) {
        return jdbc.query("SELECT project, type, name, category FROM item_states WHERE conn = ? ORDER BY project, type, sort",
                (rs, n) -> new StateRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)), conn);
    }

    @Override
    public void replaceAreas(String conn, List<String> areas) {
        tx.executeWithoutResult(s -> {
            jdbc.update("DELETE FROM areas WHERE conn = ?", conn);
            for (String a : areas) {
                jdbc.update("INSERT OR IGNORE INTO areas(conn, path) VALUES (?,?)", conn, a);
            }
        });
    }

    @Override
    public List<String> areas(String conn) {
        return jdbc.queryForList("SELECT path FROM areas WHERE conn = ? ORDER BY path", String.class, conn);
    }

    // ------------------------------------------------------------------------------------- mappings, maps, kinds

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

    @Override
    public List<TypeKindRow> typeKinds(String conn) {
        return jdbc.query("SELECT conn, type, kind FROM type_kind_map WHERE conn = ? ORDER BY type",
                (rs, n) -> new TypeKindRow(rs.getString(1), rs.getString(2), rs.getString(3)), conn);
    }

    @Override
    public void putTypeKind(TypeKindRow row) {
        jdbc.update("INSERT OR REPLACE INTO type_kind_map(conn, type, kind) VALUES (?,?,?)", row.conn(), row.type(), row.kind());
    }

    // ------------------------------------------------------------------------------------------------ board items

    private static final String BOARD_ITEM = """
            SELECT board_id, conn, item, role, relation, link_kind, parent_item, depth, type, title, state, state_category, rev, left_tree_at,
              added_at, added_by FROM board_items""";

    private final RowMapper<BoardItemRow> boardItemRow = (rs, n) -> new BoardItemRow(rs.getString(1), rs.getString(2), rs.getString(3),
            rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7), rs.getInt(8), rs.getString(9), rs.getString(10), rs.getString(11),
            rs.getString(12), rs.getInt(13), instant(rs, 14), instant(rs, 15), rs.getString(16));

    @Override
    public List<BoardItemRow> boardItems(String boardId) {
        return jdbc.query(BOARD_ITEM + " WHERE board_id = ? ORDER BY depth, title LIMIT 2000", boardItemRow, boardId);
    }

    @Override
    public Optional<BoardItemRow> boardItem(String boardId, String conn, String item) {
        return jdbc.query(BOARD_ITEM + " WHERE board_id = ? AND conn = ? AND item = ?", boardItemRow, boardId, conn, item).stream().findFirst();
    }

    @Override
    public Optional<BoardItemRow> main(String boardId) {
        return jdbc.query(BOARD_ITEM + " WHERE board_id = ? AND role = 'MAIN'", boardItemRow, boardId).stream().findFirst();
    }

    @Override
    public List<BoardItemRow> boardsOfItem(String conn, String item) {
        return jdbc.query(BOARD_ITEM + " WHERE conn = ? AND item = ? ORDER BY board_id", boardItemRow, conn, item);
    }

    @Override
    public Map<String, List<BoardBadge>> badges(String conn, Collection<String> items) {
        Map<String, List<BoardBadge>> out = new LinkedHashMap<>();
        List<String> ids = new ArrayList<>(items);
        for (int i = 0; i < ids.size(); i += 400) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + 400));
            List<Object> args = new ArrayList<>();
            args.add(conn);
            args.addAll(chunk);
            jdbc.query("""
                    SELECT b.item, b.board_id, b.role, c.rev FROM board_items b LEFT JOIN item_copies c ON c.conn = b.conn AND c.item = b.item
                    WHERE b.conn = ? AND b.item IN (""" + marks(chunk.size()) + ") ORDER BY b.board_id", rs -> {
                out.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(new BoardBadge(rs.getString(2), null, rs.getString(3), intOrNull(rs, 4), false));
            }, args.toArray());
        }
        return out;
    }

    @Override
    public void putBoardItem(BoardItemRow r) {
        jdbc.update("""
                INSERT INTO board_items(board_id, conn, item, role, relation, link_kind, parent_item, depth, type, title, state, state_category, rev,
                  left_tree_at, added_at, added_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(board_id, conn, item) DO UPDATE SET role = excluded.role, relation = excluded.relation, link_kind = excluded.link_kind,
                  parent_item = excluded.parent_item, depth = excluded.depth, type = excluded.type, title = excluded.title, state = excluded.state,
                  state_category = excluded.state_category, rev = excluded.rev, left_tree_at = excluded.left_tree_at""",
                r.boardId(), r.conn(), r.item(), r.role(), r.relation(), r.linkKind(), r.parent(), r.depth(), r.type(), r.title(), r.state(),
                r.stateCategory(), r.rev(), millis(r.leftTreeAt()), millis(r.addedAt() == null ? Instant.now() : r.addedAt()), r.addedBy());
    }

    @Override
    public void setMain(String boardId, String conn, String item, String oldRole) {
        tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE board_items SET role = ? WHERE board_id = ? AND role = 'MAIN' AND NOT (conn = ? AND item = ?)", oldRole, boardId, conn,
                    item);
            jdbc.update("UPDATE board_items SET role = 'MAIN', relation = 'ROOT', depth = 0, parent_item = NULL WHERE board_id = ? AND conn = ? AND item = ?",
                    boardId, conn, item);
        });
    }

    @Override
    public void setRole(String boardId, String conn, String item, String role) {
        jdbc.update("UPDATE board_items SET role = ? WHERE board_id = ? AND conn = ? AND item = ?", role, boardId, conn, item);
    }

    @Override
    public boolean deleteBoardItem(String boardId, String conn, String item) {
        return jdbc.update("DELETE FROM board_items WHERE board_id = ? AND conn = ? AND item = ?", boardId, conn, item) > 0;
    }

    @Override
    public int deleteTreeRefs(String boardId) {
        return jdbc.update("DELETE FROM board_items WHERE board_id = ? AND role = 'REF' AND relation IN ('ANCESTOR', 'DESCENDANT', 'LINK')", boardId);
    }

    @Override
    public void markLeftTree(String boardId, String conn, String item, Instant at) {
        jdbc.update("UPDATE board_items SET left_tree_at = ? WHERE board_id = ? AND conn = ? AND item = ? AND left_tree_at IS NULL", millis(at), boardId,
                conn, item);
    }

    @Override
    public List<String[]> deleteBoard(String boardId) {
        return tx.execute(s -> {
            List<String[]> held = new ArrayList<>();
            jdbc.query("SELECT conn, item FROM board_items WHERE board_id = ? UNION SELECT conn, item FROM card_links WHERE board_id = ?",
                    rs -> { held.add(new String[]{rs.getString(1), rs.getString(2)}); }, boardId, boardId);
            jdbc.update("DELETE FROM board_items WHERE board_id = ?", boardId);
            jdbc.update("DELETE FROM card_links WHERE board_id = ?", boardId);
            jdbc.update("DELETE FROM incoming WHERE board_id = ?", boardId);
            jdbc.update("DELETE FROM watch_rules WHERE board_id = ?", boardId);
            return held;
        });
    }

    @Override
    public List<String> boardsWithItems() {
        return jdbc.queryForList("SELECT DISTINCT board_id FROM board_items ORDER BY board_id", String.class);
    }

    // ----------------------------------------------------------------------------------------- copies and syncs

    @Override
    public Optional<ItemCopyRow> copy(String conn, String item) {
        return jdbc.query("SELECT conn, item, rev, item_json, comments_json, saved_at FROM item_copies WHERE conn = ? AND item = ?",
                (rs, n) -> new ItemCopyRow(rs.getString(1), rs.getString(2), rs.getInt(3), rs.getString(4), rs.getString(5), instant(rs, 6)), conn, item)
                .stream().findFirst();
    }

    @Override
    public void putCopy(ItemCopyRow r) {
        jdbc.update("INSERT OR REPLACE INTO item_copies(conn, item, rev, item_json, comments_json, saved_at) VALUES (?,?,?,?,?,?)", r.conn(), r.item(),
                r.rev(), r.itemJson(), r.commentsJson(), millis(r.savedAt() == null ? Instant.now() : r.savedAt()));
    }

    @Override
    public boolean dropCopyIfUnused(String conn, String item) {
        return Boolean.TRUE.equals(tx.execute(s -> {
            Integer used = jdbc.queryForObject("""
                    SELECT (SELECT COUNT(*) FROM board_items WHERE conn = ? AND item = ? AND role IN ('MAIN', 'CARD'))
                         + (SELECT COUNT(*) FROM card_links WHERE conn = ? AND item = ?)""", Integer.class, conn, item, conn, item);
            if (used != null && used > 0) {
                return false;
            }
            jdbc.update("DELETE FROM item_syncs WHERE conn = ? AND item = ?", conn, item);
            return jdbc.update("DELETE FROM item_copies WHERE conn = ? AND item = ?", conn, item) > 0;
        }));
    }

    @Override
    public long addSync(String conn, String item, int fromRev, int toRev, Instant at, List<FieldDiff> diff) {
        GeneratedKeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(c -> {
            PreparedStatement ps = c.prepareStatement("INSERT INTO item_syncs(conn, item, from_rev, to_rev, at, diff_json) VALUES (?,?,?,?,?,?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, conn);
            ps.setString(2, item);
            ps.setInt(3, fromRev);
            ps.setInt(4, toRev);
            ps.setLong(5, at.toEpochMilli());
            ps.setString(6, write(diff));
            return ps;
        }, keys);
        Number k = keys.getKey();
        return k == null ? 0 : k.longValue();
    }

    @Override
    public List<SyncRow> syncs(String conn, String item, int limit) {
        return jdbc.query("SELECT id, conn, item, from_rev, to_rev, at, diff_json, kept FROM item_syncs WHERE conn = ? AND item = ? ORDER BY id DESC LIMIT ?",
                (rs, n) -> new SyncRow(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getInt(4), rs.getInt(5), instant(rs, 6),
                        read(rs.getString(7), new TypeReference<List<FieldDiff>>() { }, List.of()), rs.getInt(8) == 1), conn, item, Math.max(1, limit));
    }

    @Override
    public void markSyncsKept(String conn, String item) {
        jdbc.update("UPDATE item_syncs SET kept = 1 WHERE conn = ? AND item = ?", conn, item);
    }

    // -------------------------------------------------------------------------------------------------- card links

    private static final String CARD_LINK = "SELECT card_id, board_id, conn, item, linked_at, linked_by, hyperlink, tag, comment_id FROM card_links";

    private final RowMapper<CardLinkRow> cardLinkRow = (rs, n) -> new CardLinkRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4),
            instant(rs, 5), rs.getString(6), rs.getInt(7) == 1, rs.getInt(8) == 1, rs.getString(9));

    @Override
    public List<CardLinkRow> cardLinks(String cardId) {
        return jdbc.query(CARD_LINK + " WHERE card_id = ? ORDER BY linked_at", cardLinkRow, cardId);
    }

    @Override
    public List<CardLinkRow> cardLinksOfItem(String conn, String item) {
        return jdbc.query(CARD_LINK + " WHERE conn = ? AND item = ? ORDER BY linked_at", cardLinkRow, conn, item);
    }

    @Override
    public List<CardLinkRow> cardLinksOfBoard(String boardId) {
        return jdbc.query(CARD_LINK + " WHERE board_id = ? ORDER BY linked_at LIMIT 2000", cardLinkRow, boardId);
    }

    @Override
    public boolean insertCardLink(CardLinkRow r) {
        try {
            return jdbc.update("""
                    INSERT INTO card_links(card_id, board_id, conn, item, linked_at, linked_by, hyperlink, tag, comment_id) VALUES (?,?,?,?,?,?,?,?,?)""",
                    r.cardId(), r.boardId(), r.conn(), r.item(), millis(r.linkedAt()), r.linkedBy(), r.hyperlink() ? 1 : 0, r.tag() ? 1 : 0,
                    r.commentId()) == 1;
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            return false;
        }
    }

    @Override
    public void putCardLink(CardLinkRow r) {
        jdbc.update("""
                INSERT OR REPLACE INTO card_links(card_id, board_id, conn, item, linked_at, linked_by, hyperlink, tag, comment_id) VALUES (?,?,?,?,?,?,?,?,?)""",
                r.cardId(), r.boardId(), r.conn(), r.item(), millis(r.linkedAt()), r.linkedBy(), r.hyperlink() ? 1 : 0, r.tag() ? 1 : 0, r.commentId());
    }

    @Override
    public boolean deleteCardLink(String cardId, String conn, String item) {
        return jdbc.update("DELETE FROM card_links WHERE card_id = ? AND conn = ? AND item = ?", cardId, conn, item) > 0;
    }

    // ---------------------------------------------------------------------------------------------------- incoming

    private static final String INCOMING = """
            SELECT board_id, conn, item, source, arrived_at, rev, type, title, match_card, match_score, proposal_action, proposal_card,
              proposal_reason, state, ignored_rev FROM incoming""";

    private final RowMapper<IncomingRow> incomingRow = (rs, n) -> new IncomingRow(rs.getString(1), rs.getString(2), rs.getString(3),
            IncomingSource.valueOf(rs.getString(4)), instant(rs, 5), rs.getInt(6), rs.getString(7), rs.getString(8), rs.getString(9), intOrNull(rs, 10),
            rs.getString(11), rs.getString(12), rs.getString(13), IncomingState.valueOf(rs.getString(14)), intOrNull(rs, 15));

    @Override
    public List<IncomingRow> incoming(String boardId, IncomingState state) {
        if (state == null) {
            return jdbc.query(INCOMING + " WHERE board_id = ? ORDER BY arrived_at DESC LIMIT 500", incomingRow, boardId);
        }
        return jdbc.query(INCOMING + " WHERE board_id = ? AND state = ? ORDER BY arrived_at DESC LIMIT 500", incomingRow, boardId, state.name());
    }

    @Override
    public Optional<IncomingRow> incomingRow(String boardId, String conn, String item) {
        return jdbc.query(INCOMING + " WHERE board_id = ? AND conn = ? AND item = ?", incomingRow, boardId, conn, item).stream().findFirst();
    }

    @Override
    public boolean arrive(IncomingRow r) {
        return Boolean.TRUE.equals(tx.execute(s -> {
            Optional<IncomingRow> old = incomingRow(r.boardId(), r.conn(), r.item());
            if (old.isPresent()) {
                IncomingRow o = old.get();
                boolean reopen = o.state() == IncomingState.IGNORED && o.ignoredRev() != null && r.rev() > o.ignoredRev();
                if (!reopen) {
                    return false;
                }
            }
            putIncoming(r);
            return true;
        }));
    }

    @Override
    public void putIncoming(IncomingRow r) {
        jdbc.update("""
                INSERT OR REPLACE INTO incoming(board_id, conn, item, source, arrived_at, rev, type, title, match_card, match_score, proposal_action,
                  proposal_card, proposal_reason, state, ignored_rev, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                r.boardId(), r.conn(), r.item(), r.source().name(), millis(r.arrivedAt()), r.rev(), r.type(), r.title(), r.matchCard(), r.matchScore(),
                r.proposalAction(), r.proposalCard(), r.proposalReason(), r.state().name(), r.ignoredRev(),
                r.state() == IncomingState.WAITING ? null : System.currentTimeMillis());
    }

    // ------------------------------------------------------------------------------------------------- watch rules

    private static final String RULE = "SELECT id, board_id, conn, name, query_json, created_at, last_run_at, last_source, last_new FROM watch_rules";

    private final RowMapper<WatchRuleRow> ruleRow = (rs, n) -> new WatchRuleRow(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
            rs.getString(5), instant(rs, 6), instant(rs, 7), rs.getString(8), rs.getInt(9));

    @Override
    public List<WatchRuleRow> rules(String boardId) {
        return jdbc.query(RULE + " WHERE board_id = ? ORDER BY id", ruleRow, boardId);
    }

    @Override
    public Optional<WatchRuleRow> rule(long id) {
        return jdbc.query(RULE + " WHERE id = ?", ruleRow, id).stream().findFirst();
    }

    @Override
    public WatchRuleRow putRule(WatchRuleRow r) {
        if (r.id() > 0) {
            jdbc.update("UPDATE watch_rules SET name = ?, query_json = ?, conn = ? WHERE id = ?", r.name(), r.queryJson(), r.conn(), r.id());
            return rule(r.id()).orElse(r);
        }
        GeneratedKeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(c -> {
            PreparedStatement ps = c.prepareStatement("INSERT INTO watch_rules(board_id, conn, name, query_json, created_at) VALUES (?,?,?,?,?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, r.boardId());
            ps.setString(2, r.conn());
            ps.setString(3, r.name());
            ps.setString(4, r.queryJson());
            ps.setLong(5, (r.createdAt() == null ? Instant.now() : r.createdAt()).toEpochMilli());
            return ps;
        }, keys);
        Number k = keys.getKey();
        return rule(k == null ? 0 : k.longValue()).orElse(r);
    }

    @Override
    public boolean deleteRule(long id) {
        return jdbc.update("DELETE FROM watch_rules WHERE id = ?", id) > 0;
    }

    @Override
    public void markRuleRun(long id, Instant at, String source, int found) {
        jdbc.update("UPDATE watch_rules SET last_run_at = ?, last_source = ?, last_new = ? WHERE id = ?", millis(at), source, found, id);
    }

    @Override
    public List<WatchRuleRow> rulesOfConnection(String conn) {
        return jdbc.query(RULE + " WHERE conn = ? ORDER BY id", ruleRow, conn);
    }

    // ---------------------------------------------------------------------------------------------- write bundles

    private static final String BUNDLE = """
            SELECT id, board_id, card_id, conn, item, origin, asked_in, title, steps_json, state, created_at, decided_at, decided_by FROM azure_writes""";

    private final RowMapper<WriteBundle> bundleRow = (rs, n) -> new WriteBundle(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
            rs.getString(5), rs.getString(6), rs.getString(7), rs.getString(8), read(rs.getString(9), new TypeReference<List<WriteStep>>() { }, List.of()),
            WriteState.valueOf(rs.getString(10)), instant(rs, 11), instant(rs, 12), rs.getString(13));

    @Override
    public long insertBundle(WriteBundle b) {
        GeneratedKeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(c -> {
            PreparedStatement ps = c.prepareStatement("""
                    INSERT INTO azure_writes(board_id, card_id, conn, item, origin, asked_in, title, steps_json, state, created_at, decided_at, decided_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, b.boardId());
            ps.setString(2, b.cardId());
            ps.setString(3, b.conn());
            ps.setString(4, b.item());
            ps.setString(5, b.origin());
            ps.setString(6, b.askedIn());
            ps.setString(7, b.title());
            ps.setString(8, write(b.steps()));
            ps.setString(9, b.state().name());
            ps.setLong(10, (b.createdAt() == null ? Instant.now() : b.createdAt()).toEpochMilli());
            if (b.decidedAt() == null) ps.setNull(11, java.sql.Types.INTEGER); else ps.setLong(11, b.decidedAt().toEpochMilli());
            ps.setString(12, b.decidedBy());
            return ps;
        }, keys);
        Number k = keys.getKey();
        return k == null ? 0 : k.longValue();
    }

    @Override
    public Optional<WriteBundle> bundle(long id) {
        return jdbc.query(BUNDLE + " WHERE id = ?", bundleRow, id).stream().findFirst();
    }

    @Override
    public List<WriteBundle> bundles(String boardId, String cardId, String state, int limit) {
        StringBuilder where = new StringBuilder(" WHERE 1 = 1");
        List<Object> args = new ArrayList<>();
        if (boardId != null) {
            where.append(" AND board_id = ?");
            args.add(boardId);
        }
        if (cardId != null) {
            where.append(" AND card_id = ?");
            args.add(cardId);
        }
        if (state != null) {
            where.append(" AND state = ?");
            args.add(state);
        }
        args.add(Math.max(1, Math.min(limit, 200)));
        return jdbc.query(BUNDLE + where + " ORDER BY id DESC LIMIT ?", bundleRow, args.toArray());
    }

    @Override
    public void updateBundle(WriteBundle b) {
        jdbc.update("UPDATE azure_writes SET title = ?, steps_json = ?, state = ?, decided_at = ?, decided_by = ? WHERE id = ?", b.title(), write(b.steps()),
                b.state().name(), millis(b.decidedAt()), b.decidedBy(), b.id());
    }

    @Override
    public void putBundleFile(long bundleId, int step, String name, byte[] data) {
        jdbc.update("INSERT OR REPLACE INTO azure_write_files(write_id, step, name, size, bytes) VALUES (?,?,?,?,?)", bundleId, step, name, data.length, data);
    }

    @Override
    public Optional<byte[]> bundleFile(long bundleId, int step) {
        return jdbc.query("SELECT bytes FROM azure_write_files WHERE write_id = ? AND step = ?", (rs, n) -> rs.getBytes(1), bundleId, step).stream()
                .findFirst();
    }

    @Override
    public void deleteBundleFiles(long bundleId) {
        jdbc.update("DELETE FROM azure_write_files WHERE write_id = ?", bundleId);
    }

    // ------------------------------------------------------------------------------------------------------- hook

    @Override
    public Optional<HookRow> hook(String conn) {
        return jdbc.query("SELECT conn, secret_hash, rotated_at, last_ping_at, last_event, bad_pings, public_address FROM hook_settings WHERE conn = ?",
                (rs, n) -> new HookRow(rs.getString(1), rs.getString(2), instant(rs, 3), instant(rs, 4), rs.getString(5), rs.getInt(6), rs.getString(7)),
                conn).stream().findFirst();
    }

    private void ensureHook(String conn) {
        jdbc.update("INSERT OR IGNORE INTO hook_settings(conn) VALUES (?)", conn);
    }

    @Override
    public void putHookSecret(String conn, String secretHash, Instant at) {
        ensureHook(conn);
        jdbc.update("UPDATE hook_settings SET secret_hash = ?, rotated_at = ? WHERE conn = ?", secretHash, millis(at), conn);
    }

    @Override
    public void recordPing(String conn, Instant at, String event) {
        ensureHook(conn);
        jdbc.update("UPDATE hook_settings SET last_ping_at = ?, last_event = ? WHERE conn = ?", millis(at), event, conn);
    }

    @Override
    public void recordBadPing(String conn) {
        ensureHook(conn);
        jdbc.update("UPDATE hook_settings SET bad_pings = bad_pings + 1 WHERE conn = ?", conn);
    }

    @Override
    public void putPublicAddress(String conn, String address) {
        ensureHook(conn);
        jdbc.update("UPDATE hook_settings SET public_address = ? WHERE conn = ?", address, conn);
    }

    @Override
    public void addWaiting(String conn, Collection<String> items, String event, Instant at) {
        tx.executeWithoutResult(s -> {
            for (String i : items) {
                jdbc.update("INSERT OR REPLACE INTO hook_waiting(conn, item, event, at) VALUES (?,?,?,?)", conn, i, event, millis(at));
            }
        });
    }

    @Override
    public List<String> waiting(String conn) {
        return jdbc.queryForList("SELECT item FROM hook_waiting WHERE conn = ? ORDER BY at LIMIT 1000", String.class, conn);
    }

    @Override
    public List<String> takeWaiting(String conn) {
        return tx.execute(s -> {
            List<String> out = waiting(conn);
            jdbc.update("DELETE FROM hook_waiting WHERE conn = ?", conn);
            return out;
        });
    }

    // ------------------------------------------------------------------------------------------------------- me

    @Override
    public Optional<MeOverride> meOverride(String conn) {
        return jdbc.query("SELECT conn, person, token_owner, at FROM me_override WHERE conn = ?",
                (rs, n) -> new MeOverride(rs.getString(1), rs.getString(2), rs.getString(3), instant(rs, 4)), conn).stream().findFirst();
    }

    @Override
    public void putMeOverride(MeOverride o) {
        jdbc.update("INSERT OR REPLACE INTO me_override(conn, person, token_owner, at) VALUES (?,?,?,?)", o.conn(), o.person(), o.tokenOwner(),
                millis(o.at() == null ? Instant.now() : o.at()));
    }

    @Override
    public void clearMeOverride(String conn) {
        jdbc.update("DELETE FROM me_override WHERE conn = ?", conn);
    }

    // ---------------------------------------------------------------------------------------- starts and pending

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
            List<PendingFile> out = pending(conn, extId);
            jdbc.update("DELETE FROM pending_attachments WHERE conn = ? AND ext_id = ?", conn, extId);
            return out;
        });
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

    // ---------------------------------------------------------------------------------------------------- retention

    @Override
    public int trim(Instant now) {
        long t = now.toEpochMilli();
        int n = 0;
        // 50 syncs per item: the oldest go
        n += jdbc.update("""
                DELETE FROM item_syncs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY conn, item ORDER BY id DESC) AS r
                  FROM item_syncs) WHERE r > 50)""");
        n += jdbc.update("DELETE FROM incoming WHERE state <> 'WAITING' AND decided_at < ?", t - Duration.ofDays(90).toMillis());
        List<Long> ended = jdbc.queryForList("SELECT id FROM azure_writes WHERE state IN ('DONE', 'PARTIAL', 'REJECTED') AND decided_at < ?", Long.class,
                t - Duration.ofDays(180).toMillis());
        for (Long id : ended) {
            deleteBundleFiles(id);
            n += jdbc.update("DELETE FROM azure_writes WHERE id = ?", id);
        }
        n += jdbc.update("DELETE FROM hook_waiting WHERE at < ?", t - Duration.ofDays(7).toMillis());
        n += jdbc.update("DELETE FROM pending_attachments WHERE fetched_at < ?", t - Duration.ofHours(24).toMillis());
        return n;
    }

    /** The whole file's size, for the storage budget. */
    public long sizeBytes() {
        try {
            return Files.size(Path.of(dbFile));
        } catch (IOException e) {
            return 0;
        }
    }

    /** For callers that need the record type without importing TeamModels twice. */
    static Class<?> models() {
        return TeamModels.class;
    }
}
