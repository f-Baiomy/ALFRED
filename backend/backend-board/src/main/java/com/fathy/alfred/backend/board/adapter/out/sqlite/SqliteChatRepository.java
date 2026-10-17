package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.domain.model.ChatChange;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSession;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatSummary;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;
import jakarta.annotation.PostConstruct;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * The board chats (specs/022, data-model.md) in board.db, through the board repository's own connection pool. Every read
 * is windowed by id; nothing reads a whole chat. {@code q_open}/{@code p_open}/{@code c_open} keep each message's open
 * questions, proposals and confirms so the chats bar counts "needs you" without parsing every message's payload.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.board", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteChatRepository implements ChatStorePort {

    private static final String MSG_COLUMNS = "id, project, cycle_id, parent_id, author, kind, text, state, urgent, decision, origin, "
            + "context_json, quote_text, extra_json, reactions_json, covers_to, reply_to, bridge_from, superseded, created_at, edited_at";
    private static final String TERM_COLUMNS = "id, project, cycle_id, message_id, urgent, mirror, text, reason, state, created_at, delivered_at, read_at";
    private static final String REC_COLUMNS = "id, message_id, kind, target, line, undo_json, created_at, undone_at";
    /** The next place in the waiting order, computed in the statement that stores it (writes to board.db are serialised). */
    private static final String NEXT_SEQ = "(SELECT COALESCE(MAX(wait_seq), 0) + 1 FROM chat_messages)";
    private static final TypeReference<List<String>> STRINGS = new TypeReference<>() { };
    private static final TypeReference<Map<String, Integer>> COUNTS = new TypeReference<>() { };

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final ObjectMapper json;

    public SqliteChatRepository(SqliteBoardRepository board, ObjectMapper json) {
        this.jdbc = board.jdbc();
        this.tx = board.tx();
        this.json = json;
    }

    @PostConstruct
    public void init() {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, cycle_id TEXT NOT NULL,
                  parent_id INTEGER, author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
                  urgent INTEGER NOT NULL DEFAULT 0, decision INTEGER NOT NULL DEFAULT 0, origin TEXT, context_json TEXT, quote_text TEXT,
                  extra_json TEXT, reactions_json TEXT, covers_to INTEGER, reply_to INTEGER, bridge_from TEXT,
                  superseded INTEGER NOT NULL DEFAULT 0, q_open INTEGER NOT NULL DEFAULT 0, p_open INTEGER NOT NULL DEFAULT 0,
                  c_open INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, edited_at INTEGER, wait_seq INTEGER, taken_by TEXT,
                  taken_at INTEGER)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(project, cycle_id, id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_parent ON chat_messages(parent_id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_waiting ON chat_messages(wait_seq) WHERE state = 'WAITING'");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_bridge ON chat_messages(project, id) WHERE bridge_from IS NOT NULL");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS chat_settings (project TEXT NOT NULL, cycle_id TEXT NOT NULL, auto_n INTEGER NOT NULL,
                  digest_gap_min INTEGER NOT NULL, watching INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, cycle_id))""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS chat_sessions (project TEXT NOT NULL, cycle_id TEXT NOT NULL, chat_session_id TEXT,
                  forked_from TEXT, host TEXT, forked_at INTEGER, seen_up_to INTEGER, terminal_at INTEGER, PRIMARY KEY (project, cycle_id))""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS chat_records (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL, target TEXT,
                  line TEXT NOT NULL, undo_json TEXT, created_at INTEGER NOT NULL, undone_at INTEGER)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_records_message ON chat_records(message_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS chat_terminal_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
                  cycle_id TEXT NOT NULL, message_id INTEGER, urgent INTEGER NOT NULL DEFAULT 0, mirror INTEGER NOT NULL DEFAULT 0,
                  text TEXT NOT NULL, reason TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_terminal_chat ON chat_terminal_items(project, cycle_id, id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_terminal_message ON chat_terminal_items(message_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS chat_watches (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, cycle_id TEXT NOT NULL,
                  kind TEXT NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL, message_id INTEGER, created_at INTEGER NOT NULL)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_chat_watches_project ON chat_watches(project, id)");
    }

    // --------------------------------------------------------------------------------------------------------- messages

    @Override
    public ChatMessage insert(ChatMessage m) {
        int[] open = openCounts(m.extra(), m.superseded());
        KeyHolder key = new GeneratedKeyHolder();
        jdbc.update(c -> {
            PreparedStatement ps = c.prepareStatement("INSERT INTO chat_messages(project, cycle_id, parent_id, author, kind, text, state, urgent, "
                    + "decision, origin, context_json, quote_text, extra_json, reactions_json, covers_to, reply_to, bridge_from, superseded, "
                    + "q_open, p_open, c_open, created_at, edited_at, wait_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,"
                    + (m.state() == ChatMessage.State.WAITING ? NEXT_SEQ : "NULL") + ")",
                    Statement.RETURN_GENERATED_KEYS);
            int i = 1;
            ps.setString(i++, m.chat().project());
            ps.setString(i++, m.chat().cycleId());
            ps.setObject(i++, m.parentId());
            ps.setString(i++, m.author().name());
            ps.setString(i++, m.kind().name());
            ps.setString(i++, m.text());
            ps.setString(i++, m.state().name());
            ps.setInt(i++, m.urgent() ? 1 : 0);
            ps.setInt(i++, m.decision() ? 1 : 0);
            ps.setString(i++, m.origin());
            ps.setString(i++, m.context().isEmpty() ? null : write(m.context()));
            ps.setString(i++, m.quote());
            ps.setString(i++, m.extra() == null || m.extra().isNull() ? null : write(m.extra()));
            ps.setString(i++, m.reactions().isEmpty() ? null : write(m.reactions()));
            ps.setObject(i++, m.coversTo());
            ps.setObject(i++, m.replyTo());
            ps.setString(i++, m.bridgeFrom());
            ps.setInt(i++, m.superseded() ? 1 : 0);
            ps.setInt(i++, open[0]);
            ps.setInt(i++, open[1]);
            ps.setInt(i++, open[2]);
            ps.setLong(i++, millis(m.createdAt() == null ? Instant.now() : m.createdAt()));
            ps.setObject(i, m.editedAt() == null ? null : m.editedAt().toEpochMilli());
            return ps;
        }, key);
        return find(key.getKey().longValue()).orElseThrow();
    }

    @Override
    public Optional<ChatMessage> find(long id) {
        return jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE id = ?", message(), id).stream().findFirst();
    }

    @Override
    public void update(ChatMessage m) {
        int[] open = openCounts(m.extra(), m.superseded());
        jdbc.update("UPDATE chat_messages SET text = ?, state = ?, urgent = ?, decision = ?, quote_text = ?, extra_json = ?, reactions_json = ?, "
                        + "covers_to = ?, superseded = ?, q_open = ?, p_open = ?, c_open = ?, edited_at = ? WHERE id = ?",
                m.text(), m.state().name(), m.urgent() ? 1 : 0, m.decision() ? 1 : 0, m.quote(),
                m.extra() == null || m.extra().isNull() ? null : write(m.extra()), m.reactions().isEmpty() ? null : write(m.reactions()),
                m.coversTo(), m.superseded() ? 1 : 0, open[0], open[1], open[2],
                m.editedAt() == null ? null : m.editedAt().toEpochMilli(), m.id());
    }

    @Override
    public boolean take(long id, String taker, Instant at) {
        return jdbc.update("UPDATE chat_messages SET state = 'TAKEN', taken_by = ?, taken_at = ? WHERE id = ? AND state = 'WAITING'",
                taker, at.toEpochMilli(), id) == 1;
    }

    @Override
    public Optional<String> takenBy(long id) {
        return jdbc.queryForList("SELECT taken_by FROM chat_messages WHERE id = ? AND state = 'TAKEN'", String.class, id).stream()
                .filter(java.util.Objects::nonNull).findFirst();
    }

    @Override
    public int requeue(ChatKey chat, String keepTaker) {
        List<Long> ids = jdbc.queryForList("SELECT id FROM chat_messages WHERE project = ? AND cycle_id = ? AND state = 'TAKEN' "
                + "AND (? IS NULL OR taken_by IS NULL OR taken_by <> ?) ORDER BY id", Long.class, chat.project(), chat.cycleId(), keepTaker, keepTaker);
        int n = 0;
        for (long id : ids) {
            n += requeue(id) ? 1 : 0;
        }
        return n;
    }

    @Override
    public boolean requeue(long id) {
        return jdbc.update("UPDATE chat_messages SET state = 'WAITING', taken_by = NULL, taken_at = NULL, wait_seq = " + NEXT_SEQ
                + " WHERE id = ? AND state = 'TAKEN'", id) == 1;
    }

    @Override
    public boolean changeState(long id, ChatMessage.State expected, ChatMessage.State next) {
        return jdbc.update("UPDATE chat_messages SET state = ? WHERE id = ? AND state = ?", next.name(), id, expected.name()) == 1;
    }

    @Override
    public List<ChatMessage> page(ChatKey chat, Long beforeId, int limit) {
        long before = beforeId == null ? Long.MAX_VALUE : beforeId;
        List<ChatMessage> newestFirst = chat.isProject()
                ? jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE project = ? AND (cycle_id = '' OR bridge_from = 'project') "
                        + "AND id < ? ORDER BY id DESC LIMIT ?", message(), chat.project(), before, limit)
                : jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE project = ? AND cycle_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                        message(), chat.project(), chat.cycleId(), before, limit);
        List<ChatMessage> out = new ArrayList<>(newestFirst);
        java.util.Collections.reverse(out);
        return out;
    }

    @Override
    public List<ChatMessage> after(ChatKey chat, long afterId, int limit) {
        return jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE project = ? AND cycle_id = ? AND id > ? ORDER BY id LIMIT ?",
                message(), chat.project(), chat.cycleId(), afterId, limit);
    }

    @Override
    public boolean editWaiting(long id, String text, Instant at) {
        return jdbc.update("UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ? AND state = 'WAITING'", text, at.toEpochMilli(), id) == 1;
    }

    @Override
    public Optional<Long> firstInFlight(ChatKey chat) {
        return jdbc.queryForList("SELECT MIN(id) FROM chat_messages WHERE project = ? AND cycle_id = ? AND author = 'USER' "
                + "AND state IN ('WAITING', 'TAKEN')", Long.class, chat.project(), chat.cycleId()).stream().filter(java.util.Objects::nonNull).findFirst();
    }

    @Override
    public List<ChatMessage> openTasks(ChatKey chat) {
        return jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE project = ? AND cycle_id = ? AND kind = 'TASK' "
                + "AND state IN ('WAITING', 'TAKEN') ORDER BY id LIMIT 100", message(), chat.project(), chat.cycleId());
    }

    @Override
    public List<ChatMessage> waiting(ChatKey chat) {
        return jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE state = 'WAITING' AND project = ? AND cycle_id = ? "
                + "ORDER BY urgent DESC, id LIMIT 500", message(), chat.project(), chat.cycleId());
    }

    @Override
    public List<Long> search(ChatKey chat, String query, String filter, int limit) {
        StringBuilder sql = new StringBuilder("SELECT id FROM chat_messages WHERE project = ? AND ")
                .append(chat.isProject() ? "(cycle_id = '' OR bridge_from = 'project')" : "cycle_id = ?");
        List<Object> args = new ArrayList<>();
        args.add(chat.project());
        if (!chat.isProject()) {
            args.add(chat.cycleId());
        }
        if (query != null && !query.isBlank()) {
            sql.append(" AND lower(text) LIKE ? ESCAPE '\\'");
            args.add("%" + like(query.strip().toLowerCase(Locale.ROOT)) + "%");
        }
        switch (filter == null ? "" : filter) {
            case "mine" -> sql.append(" AND author = 'USER'");
            case "claude" -> sql.append(" AND author = 'CLAUDE'");
            case "decisions" -> sql.append(" AND decision = 1");
            case "questions" -> sql.append(" AND q_open > 0");
            case "summaries" -> sql.append(" AND kind = 'SUMMARY'");
            case "calls" -> sql.append(" AND text LIKE '%@[call:%'");
            default -> { }
        }
        sql.append(" ORDER BY id DESC LIMIT ?");
        args.add(limit);
        return jdbc.queryForList(sql.toString(), Long.class, args.toArray());
    }

    @Override
    public Optional<ChatMessage> lastSummary(ChatKey chat) {
        return jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE project = ? AND cycle_id = ? AND kind = 'SUMMARY' "
                + "ORDER BY id DESC LIMIT 1", message(), chat.project(), chat.cycleId()).stream().findFirst();
    }

    @Override
    public boolean hasOrigin(ChatKey chat, String origin) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM chat_messages WHERE project = ? AND cycle_id = ? AND origin = ?", Integer.class,
                chat.project(), chat.cycleId(), origin);
        return n != null && n > 0;
    }

    @Override
    public int countAfter(ChatKey chat, long afterId) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM chat_messages WHERE project = ? AND cycle_id = ? AND id > ? "
                + "AND kind IN ('TEXT', 'DIGEST')", Integer.class, chat.project(), chat.cycleId(), afterId);
        return n == null ? 0 : n;
    }

    @Override
    public List<ChatSummary> summaries(String project) {
        record Row(String cycleId, long lastId, int waiting, int q, int p, int c) {
        }
        List<Row> rows = jdbc.query("SELECT cycle_id, MAX(id), SUM(CASE WHEN author = 'USER' AND state = 'WAITING' THEN 1 ELSE 0 END), "
                        + "SUM(q_open), SUM(p_open), SUM(c_open) FROM chat_messages WHERE project = ? GROUP BY cycle_id",
                (rs, n) -> new Row(rs.getString(1), rs.getLong(2), rs.getInt(3), rs.getInt(4), rs.getInt(5), rs.getInt(6)), project);
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<Long, ChatMessage> last = new HashMap<>();
        String ids = rows.stream().map(r -> String.valueOf(r.lastId())).collect(Collectors.joining(","));
        jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE id IN (" + ids + ")", message()).forEach(m -> last.put(m.id(), m));
        List<ChatSummary> out = new ArrayList<>();
        for (Row r : rows) {
            ChatMessage m = last.get(r.lastId());
            ChatKey key = new ChatKey(project, r.cycleId());
            out.add(new ChatSummary(project, key.scope(), key.scope(), !key.isProject(), r.lastId(), m == null ? null : m.createdAt(),
                    m == null ? "" : preview(m.text()), m == null ? null : m.author().name(), r.waiting(), r.q(), r.p(), r.c()));
        }
        return out;
    }

    @Override
    public List<ChatChange> changesAfter(long afterSeq, String project, String cycleId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT id, project, cycle_id, kind, urgent, parent_id, origin, text, created_at, wait_seq FROM chat_messages "
                + "WHERE state = 'WAITING' AND wait_seq > ?");
        List<Object> args = new ArrayList<>();
        args.add(afterSeq);
        if (project != null) { // null: every project; "" is "No project", as the card changes read it
            sql.append(" AND project = ?");
            args.add(project);
        }
        if (cycleId != null) {
            sql.append(" AND cycle_id = ?");
            args.add(cycleId);
        }
        sql.append(" ORDER BY wait_seq LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> new ChatChange(rs.getLong("id"), rs.getString("project"),
                new ChatKey(rs.getString("project"), rs.getString("cycle_id")).scope(), ChatMessage.Kind.valueOf(rs.getString("kind")),
                rs.getInt("urgent") == 1, nullableLong(rs, "parent_id"), rs.getString("origin"), rs.getString("text"),
                Instant.ofEpochMilli(rs.getLong("created_at")), rs.getLong("wait_seq")), args.toArray());
    }

    @Override
    public long lastMessageId() {
        Long id = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM chat_messages", Long.class);
        return id == null ? 0 : id;
    }

    // --------------------------------------------------------------------------------------------------- settings, session

    @Override
    public ChatSettings settings(ChatKey chat) {
        return jdbc.query("SELECT auto_n, digest_gap_min, watching FROM chat_settings WHERE project = ? AND cycle_id = ?",
                        (rs, n) -> new ChatSettings(chat, rs.getInt(1), rs.getInt(2), rs.getInt(3) == 1), chat.project(), chat.cycleId())
                .stream().findFirst().orElseGet(() -> ChatSettings.defaults(chat));
    }

    @Override
    public void putSettings(ChatSettings s) {
        jdbc.update("INSERT INTO chat_settings(project, cycle_id, auto_n, digest_gap_min, watching) VALUES (?,?,?,?,?) "
                        + "ON CONFLICT(project, cycle_id) DO UPDATE SET auto_n = excluded.auto_n, digest_gap_min = excluded.digest_gap_min, "
                        + "watching = excluded.watching",
                s.chat().project(), s.chat().cycleId(), s.autoN(), s.digestGapMin(), s.watching() ? 1 : 0);
    }

    @Override
    public Optional<ChatSession> session(ChatKey chat) {
        return jdbc.query("SELECT chat_session_id, forked_from, host, forked_at, seen_up_to, terminal_at FROM chat_sessions "
                        + "WHERE project = ? AND cycle_id = ?", (rs, n) -> new ChatSession(chat, rs.getString(1), rs.getString(2), rs.getString(3),
                        instant(rs, "forked_at"), instant(rs, "seen_up_to"), instant(rs, "terminal_at")), chat.project(), chat.cycleId())
                .stream().findFirst();
    }

    @Override
    public void putSession(ChatSession s) {
        jdbc.update("INSERT INTO chat_sessions(project, cycle_id, chat_session_id, forked_from, host, forked_at, seen_up_to, terminal_at) "
                        + "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project, cycle_id) DO UPDATE SET chat_session_id = excluded.chat_session_id, "
                        + "forked_from = excluded.forked_from, host = excluded.host, forked_at = excluded.forked_at, seen_up_to = excluded.seen_up_to, "
                        + "terminal_at = excluded.terminal_at",
                s.chat().project(), s.chat().cycleId(), s.chatSessionId(), s.forkedFrom(), s.host(), epoch(s.forkedAt()), epoch(s.seenUpTo()),
                epoch(s.terminalAt()));
    }

    // ---------------------------------------------------------------------------------------------------------- records

    @Override
    public ChatRecord insertRecord(ChatRecord r) {
        KeyHolder key = new GeneratedKeyHolder();
        jdbc.update(c -> {
            PreparedStatement ps = c.prepareStatement("INSERT INTO chat_records(message_id, kind, target, line, undo_json, created_at) "
                    + "VALUES (?,?,?,?,?,?)", Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, r.messageId());
            ps.setString(2, r.kind().name());
            ps.setString(3, r.target());
            ps.setString(4, r.line());
            ps.setString(5, r.undo());
            ps.setLong(6, millis(r.createdAt() == null ? Instant.now() : r.createdAt()));
            return ps;
        }, key);
        return findRecord(key.getKey().longValue()).orElseThrow();
    }

    @Override
    public Optional<ChatRecord> findRecord(long id) {
        return jdbc.query("SELECT " + REC_COLUMNS + " FROM chat_records WHERE id = ?", RECORD, id).stream().findFirst();
    }

    @Override
    public void markRecordUndone(long id) {
        jdbc.update("UPDATE chat_records SET undone_at = ? WHERE id = ? AND undone_at IS NULL", Instant.now().toEpochMilli(), id);
    }

    @Override
    public List<ChatRecord> recordsOf(Collection<Long> messageIds) {
        if (messageIds.isEmpty()) {
            return List.of();
        }
        String ids = messageIds.stream().map(String::valueOf).collect(Collectors.joining(","));
        return jdbc.query("SELECT " + REC_COLUMNS + " FROM chat_records WHERE message_id IN (" + ids + ") ORDER BY id", RECORD);
    }

    // --------------------------------------------------------------------------------------------------- terminal items

    @Override
    public TerminalItem insertTerminalItem(TerminalItem t) {
        KeyHolder key = new GeneratedKeyHolder();
        jdbc.update(c -> {
            PreparedStatement ps = c.prepareStatement("INSERT INTO chat_terminal_items(project, cycle_id, message_id, urgent, mirror, text, reason, "
                    + "state, created_at) VALUES (?,?,?,?,?,?,?,?,?)", Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, t.chat().project());
            ps.setString(2, t.chat().cycleId());
            ps.setObject(3, t.messageId());
            ps.setInt(4, t.urgent() ? 1 : 0);
            ps.setInt(5, t.mirror() ? 1 : 0);
            ps.setString(6, t.text());
            ps.setString(7, t.reason());
            ps.setString(8, t.state().name());
            ps.setLong(9, millis(t.createdAt() == null ? Instant.now() : t.createdAt()));
            return ps;
        }, key);
        return findTerminalItem(key.getKey().longValue()).orElseThrow();
    }

    @Override
    public Optional<TerminalItem> findTerminalItem(long id) {
        return jdbc.query("SELECT " + TERM_COLUMNS + " FROM chat_terminal_items WHERE id = ?", TERMINAL, id).stream().findFirst();
    }

    @Override
    public void setTerminalState(Collection<Long> ids, TerminalItem.State state) {
        if (ids.isEmpty()) {
            return;
        }
        String in = ids.stream().map(String::valueOf).collect(Collectors.joining(","));
        long now = Instant.now().toEpochMilli();
        String stamp = switch (state) {
            case DELIVERED -> ", delivered_at = COALESCE(delivered_at, " + now + ")";
            case READ -> ", read_at = COALESCE(read_at, " + now + ")";
            default -> "";
        };
        // An item already read or taken back keeps that state: undo cannot reach a read item, and a late delivery cannot
        // resurrect an undone one.
        jdbc.update("UPDATE chat_terminal_items SET state = ?" + stamp + " WHERE id IN (" + in + ") AND state NOT IN ('READ', 'UNDONE')",
                state.name());
    }

    @Override
    public List<TerminalItem> terminalItems(ChatKey chat, boolean openOnly, int limit) {
        List<TerminalItem> newestFirst = jdbc.query("SELECT " + TERM_COLUMNS + " FROM chat_terminal_items WHERE project = ? AND cycle_id = ?"
                        + (openOnly ? " AND state NOT IN ('READ', 'UNDONE')" : "") + " ORDER BY id DESC LIMIT ?",
                TERMINAL, chat.project(), chat.cycleId(), limit);
        List<TerminalItem> out = new ArrayList<>(newestFirst);
        java.util.Collections.reverse(out);
        return out;
    }

    // ---------------------------------------------------------------------------------------------------------- watches

    @Override
    public ChatWatch insertWatch(ChatWatch w) {
        KeyHolder key = new GeneratedKeyHolder();
        jdbc.update(c -> {
            PreparedStatement ps = c.prepareStatement("INSERT INTO chat_watches(project, cycle_id, kind, target, label, message_id, created_at) "
                    + "VALUES (?,?,?,?,?,?,?)", Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, w.chat().project());
            ps.setString(2, w.chat().cycleId());
            ps.setString(3, w.kind().name());
            ps.setString(4, w.target());
            ps.setString(5, w.label());
            ps.setObject(6, w.messageId());
            ps.setLong(7, millis(w.createdAt() == null ? Instant.now() : w.createdAt()));
            return ps;
        }, key);
        long id = key.getKey().longValue();
        return new ChatWatch(id, w.chat(), w.kind(), w.target(), w.label(), w.messageId(), w.createdAt() == null ? Instant.now() : w.createdAt());
    }

    @Override
    public List<ChatKey> watching(String project) {
        return jdbc.query("SELECT project, cycle_id FROM chat_settings WHERE project = ? AND watching = 1 ORDER BY cycle_id",
                (rs, n) -> new ChatKey(rs.getString(1), rs.getString(2)), project);
    }

    @Override
    public List<ChatWatch> watches(String project) {
        return jdbc.query("SELECT id, project, cycle_id, kind, target, label, message_id, created_at FROM chat_watches WHERE project = ? "
                + "ORDER BY id LIMIT 500", WATCH, project);
    }

    @Override
    public List<ChatWatch> watchesOfCycle(String cycleId) {
        return jdbc.query("SELECT id, project, cycle_id, kind, target, label, message_id, created_at FROM chat_watches WHERE cycle_id = ? "
                + "ORDER BY id LIMIT 500", WATCH, cycleId);
    }

    private static final RowMapper<ChatWatch> WATCH = (rs, n) -> new ChatWatch(rs.getLong("id"), new ChatKey(rs.getString("project"),
            rs.getString("cycle_id")), ChatWatch.Kind.valueOf(rs.getString("kind")), rs.getString("target"), rs.getString("label"),
            nullableLong(rs, "message_id"), Instant.ofEpochMilli(rs.getLong("created_at")));

    @Override
    public boolean deleteWatch(long id) {
        return jdbc.update("DELETE FROM chat_watches WHERE id = ?", id) > 0;
    }

    // ----------------------------------------------------------------------------------------------- removal, export

    @Override
    public void cycleRemoved(String cycleId) {
        if (cycleId == null || cycleId.isBlank()) {
            return;
        }
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM mentions WHERE owner_type = 'CHAT' AND owner_id IN "
                    + "(SELECT CAST(id AS TEXT) FROM chat_messages WHERE cycle_id = ?)", cycleId);
            jdbc.update("DELETE FROM chat_records WHERE message_id IN (SELECT id FROM chat_messages WHERE cycle_id = ?)", cycleId);
            jdbc.update("DELETE FROM chat_terminal_items WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM chat_watches WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM chat_messages WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM chat_settings WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM chat_sessions WHERE cycle_id = ?", cycleId);
        });
    }

    @Override
    public List<ChatMessage> exportPage(String project, String cycleId, long afterId, int limit) {
        if (cycleId != null) {
            return jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE project = ? AND cycle_id = ? AND id > ? ORDER BY id LIMIT ?",
                    message(), project, cycleId, afterId, limit);
        }
        return jdbc.query("SELECT " + MSG_COLUMNS + " FROM chat_messages WHERE project = ? AND id > ? ORDER BY id LIMIT ?", message(), project,
                afterId, limit);
    }

    @Override
    public List<TerminalItem> terminalOf(Collection<Long> messageIds) {
        if (messageIds.isEmpty()) {
            return List.of();
        }
        String ids = messageIds.stream().map(String::valueOf).collect(Collectors.joining(","));
        return jdbc.query("SELECT " + TERM_COLUMNS + " FROM chat_terminal_items WHERE message_id IN (" + ids + ") ORDER BY id", TERMINAL);
    }

    // ---------------------------------------------------------------------------------------------------------- mapping

    /**
     * Open questions, proposals and confirms in a message's payload: a question without an {@code answer}, a proposal
     * without a {@code state}, a consent without {@code decided}. An answer asked again (superseded) waits on nobody.
     */
    static int[] openCounts(JsonNode extra, boolean superseded) {
        int[] open = new int[3];
        if (extra == null || !extra.isObject() || superseded) {
            return open;
        }
        for (JsonNode q : extra.path("questions")) {
            if (!q.hasNonNull("answer")) {
                open[0]++;
            }
        }
        for (JsonNode p : extra.path("proposals")) {
            if (!p.hasNonNull("state")) {
                open[1]++;
            }
        }
        JsonNode consent = extra.path("consent");
        if (consent.isObject() && !consent.hasNonNull("decided")) {
            open[2]++;
        }
        return open;
    }

    private RowMapper<ChatMessage> message() {
        return (rs, n) -> new ChatMessage(rs.getLong("id"), new ChatKey(rs.getString("project"), rs.getString("cycle_id")),
                nullableLong(rs, "parent_id"), ChatMessage.Author.valueOf(rs.getString("author")), ChatMessage.Kind.valueOf(rs.getString("kind")),
                rs.getString("text"), ChatMessage.State.valueOf(rs.getString("state")), rs.getInt("urgent") == 1, rs.getInt("decision") == 1,
                rs.getString("origin"), read(rs.getString("context_json"), STRINGS), rs.getString("quote_text"), tree(rs.getString("extra_json")),
                read(rs.getString("reactions_json"), COUNTS), nullableLong(rs, "covers_to"), nullableLong(rs, "reply_to"),
                rs.getString("bridge_from"), rs.getInt("superseded") == 1, Instant.ofEpochMilli(rs.getLong("created_at")),
                instant(rs, "edited_at"));
    }

    private static final RowMapper<ChatRecord> RECORD = (rs, n) -> new ChatRecord(rs.getLong("id"), rs.getLong("message_id"),
            ChatRecord.Kind.valueOf(rs.getString("kind")), rs.getString("target"), rs.getString("line"), rs.getString("undo_json"),
            Instant.ofEpochMilli(rs.getLong("created_at")), instant(rs, "undone_at"));

    private static final RowMapper<TerminalItem> TERMINAL = (rs, n) -> new TerminalItem(rs.getLong("id"),
            new ChatKey(rs.getString("project"), rs.getString("cycle_id")), nullableLong(rs, "message_id"), rs.getInt("urgent") == 1,
            rs.getInt("mirror") == 1, rs.getString("text"), rs.getString("reason"), TerminalItem.State.valueOf(rs.getString("state")),
            Instant.ofEpochMilli(rs.getLong("created_at")), instant(rs, "delivered_at"), instant(rs, "read_at"));

    /** One line, plain text: mentions shown by their label, at most {@link ChatSummary#PREVIEW} characters. */
    static String preview(String text) {
        String plain = text == null ? "" : text.replaceAll("@\\[[a-z]+:[^|\\]]*\\|([^\\]]*)]", "$1").replaceAll("\\s+", " ").strip();
        return plain.length() <= ChatSummary.PREVIEW ? plain : plain.substring(0, ChatSummary.PREVIEW - 1) + "…";
    }

    private String write(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Could not store a chat value", e);
        }
    }

    private <T> T read(String text, TypeReference<T> type) {
        if (text == null) {
            return null;
        }
        try {
            return json.readValue(text, type);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private JsonNode tree(String text) {
        if (text == null) {
            return null;
        }
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static String like(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    private static Long nullableLong(ResultSet rs, String column) throws SQLException {
        long v = rs.getLong(column);
        return rs.wasNull() ? null : v;
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        long v = rs.getLong(column);
        return rs.wasNull() ? null : Instant.ofEpochMilli(v);
    }

    private static Long epoch(Instant t) {
        return t == null ? null : t.toEpochMilli();
    }

    private static long millis(Instant t) {
        return t.toEpochMilli();
    }
}
