package com.fathy.alfred.backend.sessions.adapter.out.sqlite;

import com.fathy.alfred.backend.sessions.application.port.out.SessionsStorePort;
import com.fathy.alfred.backend.sessions.domain.model.AuditEntry;
import com.fathy.alfred.backend.sessions.domain.model.BoardSession;
import com.fathy.alfred.backend.sessions.domain.model.BrowserKey;
import com.fathy.alfred.backend.sessions.domain.model.Helper;
import com.fathy.alfred.backend.sessions.domain.model.HelperCommand;
import com.fathy.alfred.backend.sessions.domain.model.Holder;
import com.fathy.alfred.backend.sessions.domain.model.PendingMessage;
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
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * sessions.db (specs/031): helpers, browsers, holders, board sessions, helper commands, user settings and the board audit.
 * Small tables, no cache: every read goes to the database. The audit keeps the newest {@link #AUDIT_ROWS} lines.
 */
@Component
public class SqliteSessionsRepository implements SessionsStorePort {

    static final int AUDIT_ROWS = 50_000;
    static final int COMMAND_ROWS = 5_000;

    @Value("${SESSIONS_DB_FILE:/appdata/sessions.db}")
    private String dbFile;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbc;
    private TransactionTemplate tx;

    public SqliteSessionsRepository() {
    }

    /** For tests: a database at {@code file}. */
    SqliteSessionsRepository(String file) {
        this.dbFile = file;
    }

    @PostConstruct
    public void init() {
        Path path = Path.of(dbFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Could not create directory for " + dbFile, e);
        }
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:sqlite:" + path + "?journal_mode=WAL&synchronous=NORMAL&busy_timeout=30000");
        config.setMaximumPoolSize(4);
        config.setPoolName("sessions-sqlite-pool");
        dataSource = new HikariDataSource(config);
        jdbc = new JdbcTemplate(dataSource);
        tx = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        createSchema();
    }

    @PreDestroy
    public void close() {
        if (dataSource != null) {
            dataSource.close();
        }
    }

    private void createSchema() {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS helpers (key_id TEXT PRIMARY KEY, user TEXT NOT NULL, machine TEXT NOT NULL, claude_account TEXT,
                  ip TEXT, info TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_helpers_user ON helpers(user)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS browser_keys (key_id TEXT PRIMARY KEY, helper_key_id TEXT NOT NULL, user TEXT NOT NULL,
                  label TEXT, hash TEXT NOT NULL, paired_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_browser_keys_user ON browser_keys(user)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS holders (board_id TEXT PRIMARY KEY, project TEXT NOT NULL, user TEXT NOT NULL, machine TEXT,
                  session_id TEXT, since INTEGER NOT NULL, commenters TEXT NOT NULL DEFAULT '', req_user TEXT, req_machine TEXT,
                  req_note TEXT, req_at INTEGER)
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS board_sessions (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, project TEXT NOT NULL,
                  cli_session_id TEXT NOT NULL, desktop_id TEXT, user TEXT NOT NULL, machine TEXT NOT NULL, helper_key_id TEXT NOT NULL,
                  cwd TEXT, title TEXT, state TEXT NOT NULL, open_in TEXT NOT NULL, last_chat_seq INTEGER NOT NULL, tokens_today INTEGER NOT NULL,
                  tokens_day TEXT, current INTEGER NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_board_sessions_board ON board_sessions(board_id, last_active)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_board_sessions_cli ON board_sessions(cli_session_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS helper_commands (id TEXT PRIMARY KEY, helper_key_id TEXT NOT NULL, user TEXT NOT NULL,
                  kind TEXT NOT NULL, board_id TEXT, project TEXT, session_id TEXT, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
                  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_helper_commands_helper ON helper_commands(helper_key_id, state, created_at)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_helper_commands_user ON helper_commands(user, created_at)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS user_settings (user TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, board_id TEXT NOT NULL,
                  what TEXT NOT NULL, user TEXT NOT NULL, machine TEXT, via TEXT)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_audit_board ON audit(board_id, id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS pending_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, project TEXT NOT NULL,
                  scope TEXT NOT NULL, user TEXT NOT NULL, machine TEXT, text TEXT NOT NULL, at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_pending_board ON pending_messages(board_id, id)");
    }

    private static Instant instant(ResultSet rs, String col) throws SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : Instant.ofEpochMilli(v);
    }

    private static Long millis(Instant i) {
        return i == null ? null : i.toEpochMilli();
    }

    // ---- keys

    private final RowMapper<Helper> helperRow = (rs, n) -> new Helper(rs.getString("key_id"), rs.getString("user"), rs.getString("machine"),
            rs.getString("claude_account"), rs.getString("ip"), rs.getString("info"), instant(rs, "created_at"), instant(rs, "last_seen"),
            instant(rs, "revoked_at"));

    private final RowMapper<BrowserKey> browserRow = (rs, n) -> new BrowserKey(rs.getString("key_id"), rs.getString("helper_key_id"),
            rs.getString("user"), rs.getString("label"), instant(rs, "paired_at"), instant(rs, "last_seen"), instant(rs, "revoked_at"));

    @Override
    public void addHelper(Helper h, String hash) {
        jdbc.update("INSERT INTO helpers(key_id, user, machine, claude_account, ip, info, hash, created_at, last_seen, revoked_at) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,?)", h.keyId(), h.user(), h.machine(), h.claudeAccount(), h.ip(), h.info(), hash,
                millis(h.createdAt()), millis(h.lastSeen()), millis(h.revokedAt()));
    }

    @Override
    public Optional<Helper> helper(String keyId) {
        return jdbc.query("SELECT * FROM helpers WHERE key_id = ?", helperRow, keyId).stream().findFirst();
    }

    @Override
    public Optional<KeyHash> keyHash(String keyId) {
        List<KeyHash> h = jdbc.query("SELECT key_id, hash FROM helpers WHERE key_id = ? AND revoked_at IS NULL",
                (rs, n) -> new KeyHash(rs.getString(1), "helper", rs.getString(2)), keyId);
        if (!h.isEmpty()) {
            return Optional.of(h.get(0));
        }
        return jdbc.query("SELECT key_id, hash FROM browser_keys WHERE key_id = ? AND revoked_at IS NULL",
                (rs, n) -> new KeyHash(rs.getString(1), "browser", rs.getString(2)), keyId).stream().findFirst();
    }

    @Override
    public List<Helper> helpersOf(String user) {
        return jdbc.query("SELECT * FROM helpers WHERE user = ? ORDER BY created_at", helperRow, user);
    }

    @Override
    public List<Helper> allHelpers() {
        return jdbc.query("SELECT * FROM helpers ORDER BY user, created_at LIMIT 5000", helperRow);
    }

    @Override
    public void helperSeen(String keyId, Instant at, String ip, String info) {
        jdbc.update("UPDATE helpers SET last_seen = ?, ip = COALESCE(?, ip), info = COALESCE(?, info) WHERE key_id = ?", millis(at), ip, info, keyId);
    }

    @Override
    public List<String> revokeHelpersOn(String user, String machine, String exceptKeyId, Instant at) {
        return tx.execute(s -> {
            List<String> ids = jdbc.queryForList("SELECT key_id FROM helpers WHERE user = ? AND machine = ? AND key_id <> ? AND revoked_at IS NULL",
                    String.class, user, machine, exceptKeyId);
            for (String id : ids) {
                revokeIn(id, at);
            }
            return ids;
        });
    }

    @Override
    public void addBrowser(BrowserKey b, String hash) {
        jdbc.update("INSERT INTO browser_keys(key_id, helper_key_id, user, label, hash, paired_at, last_seen, revoked_at) VALUES (?,?,?,?,?,?,?,?)",
                b.keyId(), b.helperKeyId(), b.user(), b.label(), hash, millis(b.pairedAt()), millis(b.lastSeen()), millis(b.revokedAt()));
    }

    @Override
    public Optional<BrowserKey> browser(String keyId) {
        return jdbc.query("SELECT * FROM browser_keys WHERE key_id = ?", browserRow, keyId).stream().findFirst();
    }

    @Override
    public List<BrowserKey> browsersOf(String user) {
        return jdbc.query("SELECT * FROM browser_keys WHERE user = ? ORDER BY paired_at", browserRow, user);
    }

    @Override
    public void browserSeen(String keyId, Instant at) {
        jdbc.update("UPDATE browser_keys SET last_seen = ? WHERE key_id = ?", millis(at), keyId);
    }

    @Override
    public boolean revoke(String keyId, Instant at) {
        Boolean done = tx.execute(s -> revokeIn(keyId, at));
        return Boolean.TRUE.equals(done);
    }

    private boolean revokeIn(String keyId, Instant at) {
        int helpers = jdbc.update("UPDATE helpers SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL", millis(at), keyId);
        if (helpers > 0) {
            jdbc.update("UPDATE browser_keys SET revoked_at = ? WHERE helper_key_id = ? AND revoked_at IS NULL", millis(at), keyId);
            jdbc.update("UPDATE helper_commands SET state = 'CANCELLED', result = 'helper revoked', updated_at = ? "
                    + "WHERE helper_key_id = ? AND state IN ('QUEUED','TAKEN')", millis(at), keyId);
            return true;
        }
        return jdbc.update("UPDATE browser_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL", millis(at), keyId) > 0;
    }

    // ---- holders

    private final RowMapper<Holder> holderRow = (rs, n) -> {
        String reqUser = rs.getString("req_user");
        Holder.Request req = reqUser == null ? null
                : new Holder.Request(reqUser, rs.getString("req_machine"), rs.getString("req_note"), instant(rs, "req_at"));
        String c = rs.getString("commenters");
        List<String> commenters = c == null || c.isBlank() ? List.of() : Arrays.asList(c.split(","));
        return new Holder(rs.getString("board_id"), rs.getString("project"), rs.getString("user"), rs.getString("machine"),
                rs.getString("session_id"), instant(rs, "since"), commenters, req);
    };

    @Override
    public Optional<Holder> holder(String boardId) {
        return jdbc.query("SELECT * FROM holders WHERE board_id = ?", holderRow, boardId).stream().findFirst();
    }

    @Override
    public List<Holder> holders(String project) {
        return project.isEmpty()
                ? jdbc.query("SELECT * FROM holders ORDER BY since LIMIT 2000", holderRow)
                : jdbc.query("SELECT * FROM holders WHERE project = ? ORDER BY since LIMIT 2000", holderRow, project);
    }

    @Override
    public List<Holder> heldBy(String user) {
        return jdbc.query("SELECT * FROM holders WHERE user = ? ORDER BY since", holderRow, user);
    }

    @Override
    public void putHolder(Holder h) {
        Holder.Request r = h.request();
        jdbc.update("INSERT OR REPLACE INTO holders(board_id, project, user, machine, session_id, since, commenters, req_user, req_machine, "
                        + "req_note, req_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", h.boardId(), h.project() == null ? "" : h.project(), h.user(),
                h.machine(), h.sessionId(), millis(h.since()), String.join(",", h.commenters()), r == null ? null : r.user(),
                r == null ? null : r.machine(), r == null ? null : r.note(), r == null ? null : millis(r.at()));
    }

    @Override
    public boolean removeHolder(String boardId) {
        return jdbc.update("DELETE FROM holders WHERE board_id = ?", boardId) > 0;
    }

    // ---- sessions

    private final RowMapper<BoardSession> sessionRow = (rs, n) -> new BoardSession(rs.getString("id"), rs.getString("board_id"),
            rs.getString("project"), rs.getString("cli_session_id"), rs.getString("desktop_id"), rs.getString("user"), rs.getString("machine"),
            rs.getString("helper_key_id"), rs.getString("cwd"), rs.getString("title"), state(rs.getString("state")), openIn(rs.getString("open_in")),
            rs.getLong("last_chat_seq"), rs.getLong("tokens_today"), rs.getString("tokens_day"), rs.getInt("current") != 0,
            instant(rs, "created_at"), instant(rs, "last_active"));

    private static BoardSession.State state(String s) {
        try {
            return BoardSession.State.valueOf(s);
        } catch (RuntimeException e) {
            return BoardSession.State.IDLE;
        }
    }

    private static BoardSession.OpenIn openIn(String s) {
        try {
            return BoardSession.OpenIn.valueOf(s);
        } catch (RuntimeException e) {
            return BoardSession.OpenIn.NONE;
        }
    }

    @Override
    public void putSession(BoardSession s) {
        jdbc.update("INSERT OR REPLACE INTO board_sessions(id, board_id, project, cli_session_id, desktop_id, user, machine, helper_key_id, cwd, "
                        + "title, state, open_in, last_chat_seq, tokens_today, tokens_day, current, created_at, last_active) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", s.id(), s.boardId(), s.project() == null ? "" : s.project(),
                s.cliSessionId(), s.desktopId(), s.user(), s.machine(), s.helperKeyId(), s.cwd(), s.title(), s.state().name(), s.openIn().name(),
                s.lastChatSeq(), s.tokensToday(), s.tokensDay(), s.current() ? 1 : 0, millis(s.createdAt()), millis(s.lastActive()));
    }

    @Override
    public Optional<BoardSession> session(String id) {
        return jdbc.query("SELECT * FROM board_sessions WHERE id = ?", sessionRow, id).stream().findFirst();
    }

    @Override
    public Optional<BoardSession> sessionByCli(String cliSessionId) {
        return jdbc.query("SELECT * FROM board_sessions WHERE cli_session_id = ? ORDER BY last_active DESC LIMIT 1", sessionRow, cliSessionId)
                .stream().findFirst();
    }

    @Override
    public List<BoardSession> sessions(String project, String boardId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT * FROM board_sessions WHERE 1=1");
        List<Object> args = new ArrayList<>();
        if (!project.isEmpty()) {
            sql.append(" AND project = ?");
            args.add(project);
        }
        if (!boardId.isEmpty()) {
            sql.append(" AND board_id = ?");
            args.add(boardId);
        }
        sql.append(" ORDER BY last_active DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), sessionRow, args.toArray());
    }

    @Override
    public void makeCurrent(String boardId, String id) {
        tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE board_sessions SET current = 0 WHERE board_id = ? AND id <> ?", boardId, id);
            jdbc.update("UPDATE board_sessions SET current = 1 WHERE id = ?", id);
        });
    }

    // ---- commands

    private final RowMapper<HelperCommand> commandRow = (rs, n) -> new HelperCommand(rs.getString("id"), rs.getString("helper_key_id"),
            rs.getString("user"), kind(rs.getString("kind")), rs.getString("board_id"), rs.getString("project"), rs.getString("session_id"),
            rs.getString("args"), commandState(rs.getString("state")), rs.getString("result"), instant(rs, "created_at"), instant(rs, "updated_at"));

    private static HelperCommand.Kind kind(String s) {
        try {
            return HelperCommand.Kind.valueOf(s);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static HelperCommand.State commandState(String s) {
        try {
            return HelperCommand.State.valueOf(s);
        } catch (RuntimeException e) {
            return HelperCommand.State.FAILED;
        }
    }

    @Override
    public void putCommand(HelperCommand c) {
        jdbc.update("INSERT OR REPLACE INTO helper_commands(id, helper_key_id, user, kind, board_id, project, session_id, args, state, result, "
                        + "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", c.id(), c.helperKeyId(), c.user(), c.kind().name(), c.boardId(),
                c.project(), c.sessionId(), c.args(), c.state().name(), c.result(), millis(c.createdAt()), millis(c.updatedAt()));
        jdbc.update("DELETE FROM helper_commands WHERE id IN (SELECT id FROM helper_commands ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
                COMMAND_ROWS);
    }

    @Override
    public Optional<HelperCommand> command(String id) {
        return jdbc.query("SELECT * FROM helper_commands WHERE id = ?", commandRow, id).stream().findFirst();
    }

    @Override
    public List<HelperCommand> commandsOf(String user, int limit) {
        return jdbc.query("SELECT * FROM helper_commands WHERE user = ? ORDER BY created_at DESC LIMIT ?", commandRow, user, limit);
    }

    @Override
    public synchronized List<HelperCommand> takeCommands(String helperKeyId, int max, Instant at) {
        return tx.execute(s -> {
            List<HelperCommand> queued = jdbc.query("SELECT * FROM helper_commands WHERE helper_key_id = ? AND state = 'QUEUED' "
                    + "ORDER BY created_at LIMIT ?", commandRow, helperKeyId, max);
            List<HelperCommand> out = new ArrayList<>();
            for (HelperCommand c : queued) {
                if (jdbc.update("UPDATE helper_commands SET state = 'TAKEN', updated_at = ? WHERE id = ? AND state = 'QUEUED'",
                        millis(at), c.id()) > 0) {
                    out.add(c.with(HelperCommand.State.TAKEN, c.result(), at));
                }
            }
            return out;
        });
    }

    // ---- commenters' chat messages

    private final RowMapper<PendingMessage> pendingRow = (rs, n) ->
            new PendingMessage(rs.getLong("id"), rs.getString("board_id"), rs.getString("project"),
                    rs.getString("scope"), rs.getString("user"), rs.getString("machine"), rs.getString("text"), instant(rs, "at"));

    @Override
    public long addPending(PendingMessage m) {
        Long id = jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Long>) con -> {
            try (var ps = con.prepareStatement("INSERT INTO pending_messages(board_id, project, scope, user, machine, text, at) VALUES (?,?,?,?,?,?,?)")) {
                ps.setString(1, m.boardId());
                ps.setString(2, m.project());
                ps.setString(3, m.scope());
                ps.setString(4, m.user());
                ps.setString(5, m.machine());
                ps.setString(6, m.text());
                ps.setLong(7, m.at().toEpochMilli());
                ps.executeUpdate();
            }
            try (var st = con.createStatement(); var rs = st.executeQuery("SELECT last_insert_rowid()")) {
                return rs.next() ? rs.getLong(1) : 0L;
            }
        });
        return id == null ? 0 : id;
    }

    @Override
    public List<PendingMessage> pending(String boardId) {
        return jdbc.query("SELECT * FROM pending_messages WHERE board_id = ? ORDER BY id LIMIT 500", pendingRow, boardId);
    }

    @Override
    public Optional<PendingMessage> pendingMessage(long id) {
        return jdbc.query("SELECT * FROM pending_messages WHERE id = ?", pendingRow, id).stream().findFirst();
    }

    @Override
    public boolean removePending(long id) {
        return jdbc.update("DELETE FROM pending_messages WHERE id = ?", id) > 0;
    }

    // ---- settings and audit

    @Override
    public Optional<String> settings(String user) {
        return jdbc.queryForList("SELECT json FROM user_settings WHERE user = ?", String.class, user).stream().findFirst();
    }

    @Override
    public void putSettings(String user, String json, Instant at) {
        jdbc.update("INSERT OR REPLACE INTO user_settings(user, json, updated_at) VALUES (?,?,?)", user, json, millis(at));
    }

    @Override
    public long audit(AuditEntry e) {
        // insert and read the row id on one connection: last_insert_rowid() is per connection
        Long id = jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Long>) con -> {
            try (var ps = con.prepareStatement("INSERT INTO audit(at, board_id, what, user, machine, via) VALUES (?,?,?,?,?,?)")) {
                ps.setLong(1, e.at().toEpochMilli());
                ps.setString(2, e.boardId());
                ps.setString(3, e.what());
                ps.setString(4, e.user());
                ps.setString(5, e.machine());
                ps.setString(6, e.via());
                ps.executeUpdate();
            }
            try (var st = con.createStatement(); var rs = st.executeQuery("SELECT last_insert_rowid()")) {
                return rs.next() ? rs.getLong(1) : 0L;
            }
        });
        long last = id == null ? 0 : id;
        if (last % 1000 == 0) {
            jdbc.update("DELETE FROM audit WHERE id <= ?", last - AUDIT_ROWS);
        }
        return last;
    }

    @Override
    public List<AuditEntry> audit(String boardId, int limit) {
        return jdbc.query("SELECT * FROM audit WHERE board_id = ? ORDER BY id DESC LIMIT ?",
                (rs, n) -> new AuditEntry(rs.getLong("id"), instant(rs, "at"), rs.getString("board_id"), rs.getString("what"), rs.getString("user"),
                        rs.getString("machine"), rs.getString("via")), boardId, limit);
    }
}
