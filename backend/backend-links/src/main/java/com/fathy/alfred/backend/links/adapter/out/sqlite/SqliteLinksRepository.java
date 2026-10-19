package com.fathy.alfred.backend.links.adapter.out.sqlite;

import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.domain.model.EnvAssignment;
import com.fathy.alfred.backend.links.domain.model.EnvCycle;
import com.fathy.alfred.backend.links.domain.model.EnvDef;
import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.ReadEntry;
import com.fathy.alfred.backend.links.domain.model.RequestKind;
import com.fathy.alfred.backend.links.domain.model.RequestState;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;
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
import java.util.List;
import java.util.Optional;

/**
 * links.db (specs/035): this Alfred's id, its links, the streams it offers and was given, requests, the durable event
 * outbox and inbox cursor (D26), the read log (D31), and environments (D35-D41). Small tables, no cache. Never a call,
 * body or board text: nothing streamed is stored (D20).
 */
@Component
public class SqliteLinksRepository implements LinksStorePort {

    /** Events older than this are dropped even if never acked: a link offline for a month is told "resync" instead. */
    static final int OUTBOX_ROWS_PER_LINK = 5_000;

    @Value("${LINKS_DB_FILE:/appdata/links.db}")
    private String dbFile;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbc;
    private TransactionTemplate tx;

    public SqliteLinksRepository() {
    }

    /** For tests: a database at {@code file}. */
    public SqliteLinksRepository(String file) {
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
        config.setPoolName("links-sqlite-pool");
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
        jdbc.execute("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, peer_alfred_id TEXT NOT NULL,
                  peer_name TEXT, address TEXT, dialer INTEGER NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER,
                  peer_version TEXT, removed_at INTEGER)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_links_peer ON links(peer_alfred_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS streams (id TEXT PRIMARY KEY, mine INTEGER NOT NULL, link_id TEXT NOT NULL, kind TEXT NOT NULL,
                  target TEXT NOT NULL, target_name TEXT, project TEXT, mode TEXT NOT NULL, auto INTEGER NOT NULL, pass_on INTEGER NOT NULL,
                  pass_mode TEXT NOT NULL, unmasked INTEGER NOT NULL, env TEXT, for_board TEXT, created_at INTEGER NOT NULL, ended_at INTEGER)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_streams_link ON streams(link_id, mine)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, link_id TEXT NOT NULL, incoming INTEGER NOT NULL,
                  kind TEXT NOT NULL, target TEXT NOT NULL, target_label TEXT, text TEXT NOT NULL, extra TEXT, author TEXT NOT NULL,
                  state TEXT NOT NULL, result_ref TEXT, note TEXT, created_at INTEGER NOT NULL, answered_at INTEGER, auto INTEGER NOT NULL DEFAULT 0)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_requests_state ON requests(incoming, state, created_at)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS request_relays (request_id TEXT PRIMARY KEY, for_link_id TEXT NOT NULL)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, link_id TEXT NOT NULL, kind TEXT NOT NULL,
                  data TEXT NOT NULL, at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_outbox_link ON outbox(link_id, seq)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS inbox (link_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS read_log (link_id TEXT NOT NULL, family TEXT NOT NULL, target TEXT NOT NULL, day TEXT NOT NULL,
                  via TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
                  PRIMARY KEY (link_id, family, target, day, via))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS env_defs (board_id TEXT NOT NULL, name TEXT NOT NULL, link_id TEXT, required INTEGER NOT NULL,
                  ord INTEGER NOT NULL, PRIMARY KEY (board_id, name))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS env_assignments (host_link_id TEXT NOT NULL, board_id TEXT NOT NULL, env TEXT NOT NULL,
                  board_name TEXT, project TEXT, PRIMARY KEY (host_link_id, board_id, env))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS env_marks (host_link_id TEXT NOT NULL, board_id TEXT NOT NULL, file_name TEXT NOT NULL,
                  item_key TEXT NOT NULL, mark TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, at INTEGER NOT NULL,
                  history TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (host_link_id, board_id, file_name, item_key))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS env_steps (host_link_id TEXT NOT NULL, board_id TEXT NOT NULL, step_key TEXT NOT NULL,
                  state TEXT NOT NULL, note TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (host_link_id, board_id, step_key))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS env_retests (host_link_id TEXT NOT NULL, board_id TEXT NOT NULL, card_number INTEGER NOT NULL,
                  verdict TEXT NOT NULL, summary TEXT, cycle_id TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL,
                  PRIMARY KEY (host_link_id, board_id, card_number))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS env_cycles (host_link_id TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL, cycle_ref TEXT NOT NULL,
                  env TEXT NOT NULL, name TEXT, retest_for TEXT NOT NULL DEFAULT '[]', at INTEGER NOT NULL,
                  PRIMARY KEY (host_link_id, board_id, cycle_ref))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_env_cycles_ref ON env_cycles(cycle_ref)");
    }

    private static Instant instant(ResultSet rs, String col) throws SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : Instant.ofEpochMilli(v);
    }

    private static Long millis(Instant at) {
        return at == null ? null : at.toEpochMilli();
    }

    // ------------------------------------------------------------------------------------------------------ settings

    @Override
    public Optional<String> setting(String key) {
        return jdbc.queryForList("SELECT v FROM settings WHERE k = ?", String.class, key).stream().findFirst();
    }

    @Override
    public void setting(String key, String value) {
        jdbc.update("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
    }

    // --------------------------------------------------------------------------------------------------------- links

    private static final RowMapper<Link> LINK = (rs, n) -> new Link(rs.getString("id"), rs.getString("slug"), rs.getString("name"),
            rs.getString("peer_alfred_id"), rs.getString("peer_name"), rs.getString("address"), rs.getInt("dialer") == 1,
            rs.getString("secret"), instant(rs, "created_at"), instant(rs, "last_seen"), rs.getString("peer_version"),
            instant(rs, "removed_at"));

    @Override
    public List<Link> links(boolean includeRemoved) {
        return jdbc.query("SELECT * FROM links" + (includeRemoved ? "" : " WHERE removed_at IS NULL") + " ORDER BY created_at", LINK);
    }

    @Override
    public Optional<Link> link(String id) {
        return jdbc.query("SELECT * FROM links WHERE id = ?", LINK, id).stream().findFirst();
    }

    @Override
    public Optional<Link> linkBySlug(String slug) {
        return jdbc.query("SELECT * FROM links WHERE slug = ?", LINK, slug).stream().findFirst();
    }

    @Override
    public Optional<Link> linkByPeer(String peerAlfredId) {
        return jdbc.query("SELECT * FROM links WHERE peer_alfred_id = ? ORDER BY removed_at IS NULL DESC, created_at DESC", LINK, peerAlfredId)
                .stream().findFirst();
    }

    @Override
    public void saveLink(Link l) {
        jdbc.update("""
                INSERT INTO links (id, slug, name, peer_alfred_id, peer_name, address, dialer, secret, created_at, last_seen, peer_version, removed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, peer_alfred_id = excluded.peer_alfred_id, peer_name = excluded.peer_name,
                  address = excluded.address, dialer = excluded.dialer, secret = excluded.secret, created_at = excluded.created_at,
                  last_seen = excluded.last_seen, peer_version = excluded.peer_version, removed_at = excluded.removed_at
                """, l.id(), l.slug(), l.name(), l.peerAlfredId(), l.peerName(), l.address(), l.dialer() ? 1 : 0, l.secret(),
                millis(l.createdAt()), millis(l.lastSeen()), l.peerVersion(), millis(l.removedAt()));
    }

    // ------------------------------------------------------------------------------------------------------- streams

    private static final RowMapper<Stream> STREAM = (rs, n) -> new Stream(rs.getString("id"), rs.getInt("mine") == 1, rs.getString("link_id"),
            StreamKind.valueOf(rs.getString("kind")), rs.getString("target"), rs.getString("target_name"), rs.getString("project"),
            StreamMode.valueOf(rs.getString("mode")), rs.getInt("auto") == 1, rs.getInt("pass_on") == 1, StreamMode.valueOf(rs.getString("pass_mode")),
            rs.getInt("unmasked") == 1, rs.getString("env"), rs.getString("for_board"), instant(rs, "created_at"), instant(rs, "ended_at"));

    @Override
    public List<Stream> streams() {
        return jdbc.query("SELECT * FROM streams ORDER BY created_at", STREAM);
    }

    @Override
    public Optional<Stream> stream(String id) {
        return jdbc.query("SELECT * FROM streams WHERE id = ?", STREAM, id).stream().findFirst();
    }

    @Override
    public void deleteStream(String id) {
        jdbc.update("DELETE FROM streams WHERE id = ?", id);
    }

    @Override
    public void saveStream(Stream s) {
        jdbc.update("""
                INSERT INTO streams (id, mine, link_id, kind, target, target_name, project, mode, auto, pass_on, pass_mode, unmasked, env, for_board,
                  created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET target_name = excluded.target_name, project = excluded.project, mode = excluded.mode,
                  auto = excluded.auto, pass_on = excluded.pass_on, pass_mode = excluded.pass_mode, unmasked = excluded.unmasked,
                  env = excluded.env, for_board = excluded.for_board, ended_at = excluded.ended_at
                """, s.id(), s.mine() ? 1 : 0, s.linkId(), s.kind().name(), s.target(), s.targetName(), s.project(), s.mode().name(),
                s.autoAccept() ? 1 : 0, s.passOn() ? 1 : 0, s.passMode().name(), s.unmasked() ? 1 : 0, s.env(), s.forBoard(),
                millis(s.createdAt()), millis(s.endedAt()));
    }

    // ------------------------------------------------------------------------------------------------------ requests

    private static final RowMapper<LinkRequest> REQUEST = (rs, n) -> new LinkRequest(rs.getString("id"), rs.getString("stream_id"),
            rs.getString("link_id"), rs.getInt("incoming") == 1, RequestKind.valueOf(rs.getString("kind")), rs.getString("target"),
            rs.getString("target_label"), rs.getString("text"), rs.getString("extra"), rs.getString("author"),
            RequestState.valueOf(rs.getString("state")), rs.getString("result_ref"), rs.getString("note"), instant(rs, "created_at"),
            instant(rs, "answered_at"), rs.getInt("auto") == 1);

    @Override
    public Optional<LinkRequest> request(String id) {
        return jdbc.query("SELECT * FROM requests WHERE id = ?", REQUEST, id).stream().findFirst();
    }

    @Override
    public void saveRequest(LinkRequest r) {
        jdbc.update("""
                INSERT INTO requests (id, stream_id, link_id, incoming, kind, target, target_label, text, extra, author, state, result_ref, note,
                  created_at, answered_at, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET state = excluded.state, result_ref = excluded.result_ref, note = excluded.note,
                  answered_at = excluded.answered_at, auto = excluded.auto, target_label = excluded.target_label
                """, r.id(), r.streamId(), r.linkId(), r.incoming() ? 1 : 0, r.kind().name(), r.target(), r.targetLabel(), r.text(), r.extra(),
                r.author(), r.state().name(), r.resultRef(), r.note(), millis(r.createdAt()), millis(r.answeredAt()), r.auto() ? 1 : 0);
    }

    @Override
    public boolean answerRequest(LinkRequest next, RequestState expected) {
        return jdbc.update("UPDATE requests SET state = ?, result_ref = ?, note = ?, answered_at = ?, auto = ? WHERE id = ? AND state = ?",
                next.state().name(), next.resultRef(), next.note(), millis(next.answeredAt()), next.auto() ? 1 : 0, next.id(), expected.name()) == 1;
    }

    @Override
    public List<LinkRequest> requests(Boolean incoming, RequestState state, String linkId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT * FROM requests WHERE 1 = 1");
        List<Object> args = new ArrayList<>();
        if (incoming != null) {
            sql.append(" AND incoming = ?");
            args.add(incoming ? 1 : 0);
        }
        if (state != null) {
            sql.append(" AND state = ?");
            args.add(state.name());
        }
        if (linkId != null && !linkId.isBlank()) {
            sql.append(" AND link_id = ?");
            args.add(linkId);
        }
        sql.append(" ORDER BY created_at DESC LIMIT ?");
        args.add(Math.max(1, Math.min(limit, 1000)));
        return jdbc.query(sql.toString(), REQUEST, args.toArray());
    }

    @Override
    public int countRequests(boolean incoming, RequestState state) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM requests WHERE incoming = ? AND state = ?", Integer.class, incoming ? 1 : 0,
                state.name());
        return n == null ? 0 : n;
    }

    @Override
    public void relayFor(String requestId, String forLinkId) {
        jdbc.update("INSERT INTO request_relays (request_id, for_link_id) VALUES (?, ?) ON CONFLICT(request_id) DO UPDATE SET for_link_id = excluded.for_link_id",
                requestId, forLinkId);
    }

    @Override
    public Optional<String> relayedFor(String requestId) {
        return jdbc.queryForList("SELECT for_link_id FROM request_relays WHERE request_id = ?", String.class, requestId).stream().findFirst();
    }

    // -------------------------------------------------------------------------------------------------------- events

    @Override
    public long enqueue(String linkId, String kind, String data, Instant at) {
        Long seq = tx.execute(status -> {
            jdbc.update("INSERT INTO outbox (link_id, kind, data, at) VALUES (?, ?, ?, ?)", linkId, kind, data, at.toEpochMilli());
            Long id = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            jdbc.update("DELETE FROM outbox WHERE link_id = ? AND seq <= (SELECT seq FROM outbox WHERE link_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
                    linkId, linkId, OUTBOX_ROWS_PER_LINK);
            return id;
        });
        return seq == null ? 0 : seq;
    }

    @Override
    public List<OutboxEvent> outbox(String linkId) {
        return jdbc.query("SELECT * FROM outbox WHERE link_id = ? ORDER BY seq", (rs, n) -> new OutboxEvent(rs.getLong("seq"),
                rs.getString("link_id"), rs.getString("kind"), rs.getString("data"), instant(rs, "at")), linkId);
    }

    @Override
    public void acked(String linkId, long seq) {
        jdbc.update("DELETE FROM outbox WHERE link_id = ? AND seq <= ?", linkId, seq);
    }

    @Override
    public long lastReceived(String linkId) {
        return jdbc.queryForList("SELECT last_seq FROM inbox WHERE link_id = ?", Long.class, linkId).stream().findFirst().orElse(0L);
    }

    @Override
    public boolean received(String linkId, long seq) {
        Boolean fresh = tx.execute(status -> {
            long last = lastReceived(linkId);
            if (seq <= last) {
                return false;
            }
            jdbc.update("INSERT INTO inbox (link_id, last_seq) VALUES (?, ?) ON CONFLICT(link_id) DO UPDATE SET last_seq = excluded.last_seq",
                    linkId, seq);
            return true;
        });
        return Boolean.TRUE.equals(fresh);
    }

    @Override
    public void clearEvents(String linkId) {
        jdbc.update("DELETE FROM outbox WHERE link_id = ?", linkId);
        jdbc.update("DELETE FROM inbox WHERE link_id = ?", linkId);
    }

    // ------------------------------------------------------------------------------------------------------ read log

    @Override
    public void countRead(String linkId, String family, String target, String via, Instant at) {
        String day = at.toString().substring(0, 10);
        jdbc.update("""
                INSERT INTO read_log (link_id, family, target, day, via, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(link_id, family, target, day, via) DO UPDATE SET count = count + 1, last_at = excluded.last_at
                """, linkId, family, target == null ? "" : target, day, via == null ? "" : via, at.toEpochMilli(), at.toEpochMilli());
    }

    @Override
    public List<ReadEntry> reads(String linkId, String sinceDay) {
        String sql = "SELECT * FROM read_log WHERE day >= ?" + (linkId == null ? "" : " AND link_id = ?") + " ORDER BY last_at DESC LIMIT 2000";
        Object[] args = linkId == null ? new Object[]{sinceDay} : new Object[]{sinceDay, linkId};
        return jdbc.query(sql, (rs, n) -> new ReadEntry(rs.getString("link_id"), rs.getString("family"), rs.getString("target"),
                rs.getString("day"), rs.getLong("count"), instant(rs, "first_at"), instant(rs, "last_at"), rs.getString("via")), args);
    }

    @Override
    public void pruneReads(String beforeDay) {
        jdbc.update("DELETE FROM read_log WHERE day < ?", beforeDay);
    }

    // -------------------------------------------------------------------------------------------------- environments

    private static final RowMapper<EnvDef> ENV_DEF = (rs, n) -> new EnvDef(rs.getString("board_id"), rs.getString("name"),
            rs.getString("link_id"), rs.getInt("required") == 1, rs.getInt("ord"));

    @Override
    public List<EnvDef> envDefs(String boardId) {
        return jdbc.query("SELECT * FROM env_defs WHERE board_id = ? ORDER BY ord, name", ENV_DEF, boardId);
    }

    @Override
    public List<EnvDef> envDefsOfLink(String linkId) {
        return jdbc.query("SELECT * FROM env_defs WHERE link_id = ? ORDER BY board_id, ord", ENV_DEF, linkId);
    }

    @Override
    public void saveEnvDefs(String boardId, List<EnvDef> defs) {
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM env_defs WHERE board_id = ?", boardId);
            for (EnvDef d : defs) {
                jdbc.update("INSERT INTO env_defs (board_id, name, link_id, required, ord) VALUES (?, ?, ?, ?, ?)", boardId, d.name(), d.linkId(),
                        d.required() ? 1 : 0, d.ord());
            }
        });
    }

    private static final RowMapper<EnvAssignment> ASSIGNMENT = (rs, n) -> new EnvAssignment(rs.getString("host_link_id"),
            rs.getString("board_id"), rs.getString("env"), rs.getString("board_name"), rs.getString("project"));

    @Override
    public List<EnvAssignment> assignments(String hostLinkId) {
        return jdbc.query("SELECT * FROM env_assignments WHERE host_link_id = ? ORDER BY board_id, env", ASSIGNMENT, hostLinkId);
    }

    @Override
    public List<EnvAssignment> allAssignments() {
        return jdbc.query("SELECT * FROM env_assignments ORDER BY host_link_id, board_id, env", ASSIGNMENT);
    }

    @Override
    public void saveAssignments(String hostLinkId, String boardId, List<EnvAssignment> list) {
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM env_assignments WHERE host_link_id = ? AND board_id = ?", hostLinkId, boardId);
            for (EnvAssignment a : list) {
                jdbc.update("INSERT INTO env_assignments (host_link_id, board_id, env, board_name, project) VALUES (?, ?, ?, ?, ?)", hostLinkId,
                        boardId, a.env(), a.boardName(), a.project());
            }
        });
    }

    private static final RowMapper<EnvMark> MARK = (rs, n) -> new EnvMark(rs.getString("host_link_id"), rs.getString("board_id"),
            rs.getString("file_name"), rs.getString("item_key"), rs.getString("mark"), rs.getString("evidence"), rs.getString("actor"),
            instant(rs, "at"), rs.getString("history"));

    @Override
    public List<EnvMark> envMarks(String hostLinkId, String boardId) {
        return jdbc.query("SELECT * FROM env_marks WHERE host_link_id = ? AND board_id = ?", MARK, hostLinkId, boardId);
    }

    @Override
    public Optional<EnvMark> envMark(String hostLinkId, String boardId, String fileName, String itemKey) {
        return jdbc.query("SELECT * FROM env_marks WHERE host_link_id = ? AND board_id = ? AND file_name = ? AND item_key = ?", MARK, hostLinkId,
                boardId, fileName, itemKey).stream().findFirst();
    }

    @Override
    public void saveEnvMark(EnvMark m) {
        jdbc.update("""
                INSERT INTO env_marks (host_link_id, board_id, file_name, item_key, mark, evidence, actor, at, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(host_link_id, board_id, file_name, item_key) DO UPDATE SET mark = excluded.mark, evidence = excluded.evidence,
                  actor = excluded.actor, at = excluded.at, history = excluded.history
                """, m.hostLinkId(), m.boardId(), m.fileName(), m.itemKey(), m.mark(), m.evidence() == null ? "" : m.evidence(), m.actor(),
                millis(m.at()), m.history() == null ? "[]" : m.history());
    }

    @Override
    public void deleteEnvMark(String hostLinkId, String boardId, String fileName, String itemKey) {
        jdbc.update("DELETE FROM env_marks WHERE host_link_id = ? AND board_id = ? AND file_name = ? AND item_key = ?", hostLinkId, boardId,
                fileName, itemKey);
    }

    private static final RowMapper<EnvStep> STEP = (rs, n) -> new EnvStep(rs.getString("host_link_id"), rs.getString("board_id"),
            rs.getString("step_key"), rs.getString("state"), rs.getString("note"), rs.getString("actor"), instant(rs, "at"));

    @Override
    public List<EnvStep> envSteps(String hostLinkId, String boardId) {
        return jdbc.query("SELECT * FROM env_steps WHERE host_link_id = ? AND board_id = ?", STEP, hostLinkId, boardId);
    }

    @Override
    public void saveEnvStep(EnvStep s) {
        jdbc.update("""
                INSERT INTO env_steps (host_link_id, board_id, step_key, state, note, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(host_link_id, board_id, step_key) DO UPDATE SET state = excluded.state, note = excluded.note, actor = excluded.actor,
                  at = excluded.at
                """, s.hostLinkId(), s.boardId(), s.stepKey(), s.state(), s.note(), s.actor(), millis(s.at()));
    }

    @Override
    public void deleteEnvStep(String hostLinkId, String boardId, String stepKey) {
        jdbc.update("DELETE FROM env_steps WHERE host_link_id = ? AND board_id = ? AND step_key = ?", hostLinkId, boardId, stepKey);
    }

    @Override
    public List<EnvRetest> envRetests(String hostLinkId, String boardId) {
        return jdbc.query("SELECT * FROM env_retests WHERE host_link_id = ? AND board_id = ? ORDER BY card_number", (rs, n) -> new EnvRetest(
                rs.getString("host_link_id"), rs.getString("board_id"), rs.getInt("card_number"), rs.getString("verdict"), rs.getString("summary"),
                rs.getString("cycle_id"), rs.getString("actor"), instant(rs, "at")), hostLinkId, boardId);
    }

    @Override
    public void saveEnvRetest(EnvRetest r) {
        jdbc.update("""
                INSERT INTO env_retests (host_link_id, board_id, card_number, verdict, summary, cycle_id, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(host_link_id, board_id, card_number) DO UPDATE SET verdict = excluded.verdict, summary = excluded.summary,
                  cycle_id = excluded.cycle_id, actor = excluded.actor, at = excluded.at
                """, r.hostLinkId(), r.boardId(), r.cardNumber(), r.verdict(), r.summary(), r.cycleId(), r.actor(), millis(r.at()));
    }

    private static final RowMapper<EnvCycle> ENV_CYCLE = (rs, n) -> new EnvCycle(blankNull(rs.getString("host_link_id")), rs.getString("board_id"),
            rs.getString("cycle_ref"), rs.getString("env"), rs.getString("name"), numbers(rs.getString("retest_for")), instant(rs, "at"));

    private static String blankNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    private static List<Integer> numbers(String json) {
        List<Integer> out = new ArrayList<>();
        if (json == null) {
            return out;
        }
        for (String part : json.replaceAll("[\\[\\]\\s]", "").split(",")) {
            if (!part.isEmpty()) {
                try {
                    out.add(Integer.parseInt(part));
                } catch (NumberFormatException ignored) {
                    // not a card number
                }
            }
        }
        return out;
    }

    @Override
    public List<EnvCycle> envCycles(String hostLinkId, String boardId) {
        return jdbc.query("SELECT * FROM env_cycles WHERE host_link_id = ? AND board_id = ? ORDER BY at", ENV_CYCLE,
                hostLinkId == null ? "" : hostLinkId, boardId);
    }

    @Override
    public List<EnvCycle> envCyclesOf(String cycleRef) {
        return jdbc.query("SELECT * FROM env_cycles WHERE cycle_ref = ? ORDER BY at", ENV_CYCLE, cycleRef);
    }

    @Override
    public void saveEnvCycle(EnvCycle c) {
        jdbc.update("""
                INSERT INTO env_cycles (host_link_id, board_id, cycle_ref, env, name, retest_for, at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(host_link_id, board_id, cycle_ref) DO UPDATE SET env = excluded.env, name = excluded.name,
                  retest_for = excluded.retest_for
                """, c.hostLinkId() == null ? "" : c.hostLinkId(), c.boardId(), c.cycleRef(), c.env(), c.name(), c.retestFor().toString(),
                millis(c.at() == null ? Instant.now() : c.at()));
    }

    @Override
    public void deleteEnvCycle(String hostLinkId, String boardId, String cycleRef) {
        jdbc.update("DELETE FROM env_cycles WHERE host_link_id = ? AND board_id = ? AND cycle_ref = ?", hostLinkId == null ? "" : hostLinkId,
                boardId, cycleRef);
    }
}
