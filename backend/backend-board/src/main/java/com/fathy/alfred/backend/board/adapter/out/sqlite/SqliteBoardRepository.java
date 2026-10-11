package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import com.fathy.alfred.backend.board.domain.model.CallBadge;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CardsPage;
import com.fathy.alfred.backend.board.domain.model.ChecklistMark;
import com.fathy.alfred.backend.board.domain.model.ChecklistSuggestion;
import com.fathy.alfred.backend.board.domain.model.ClosedReason;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.Mark;
import com.fathy.alfred.backend.board.domain.model.Mention;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.CardRef;
import com.fathy.alfred.backend.board.domain.model.SessionLogEntry;
import com.fathy.alfred.backend.board.domain.model.StepState;
import com.fathy.alfred.backend.board.domain.model.TestStep;
import com.fathy.alfred.backend.board.domain.model.NextSteps;
import com.fathy.alfred.backend.board.domain.model.Waiting;
import com.fathy.alfred.backend.board.domain.model.WaitingOn;
import com.fathy.alfred.backend.board.domain.model.Proposal;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.Scope;
import com.fathy.alfred.backend.board.domain.model.SimilarClosed;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import com.fathy.alfred.backend.board.domain.model.SpecFileInfo;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
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
import java.util.Collection;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * board.db (specs/014-task-board data-model.md). SQLite only: the board is a new slice with no legacy flat file to
 * migrate (research R2, the triage precedent). Board lists select summary columns only - never {@code description} -
 * and always carry a LIMIT; history is paged; mentions are an index rebuilt from text on every save.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.board", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteBoardRepository implements BoardStorePort {

    private static final Logger log = LoggerFactory.getLogger(SqliteBoardRepository.class);
    private static final int IN_CHUNK = 400;
    /** Seatbelt on badge lists: a cycle has hundreds of calls, not hundreds of thousands. */
    private static final int BADGE_ROWS = 20_000;
    private static final TypeReference<List<ChecklistMark.Change>> CHANGES = new TypeReference<>() { };

    static final String SUMMARY_COLUMNS = "id, project, number, kind, title, status, resolution, reason, flags, scope, author, "
            + "cycle_id, cycle_deleted, signature, created_at, updated_at, updated_by";
    private static final String DETAIL_COLUMNS = SUMMARY_COLUMNS + ", description";

    private final ObjectMapper objectMapper;

    @Value("${BOARD_DB_FILE:/appdata/board.db}")
    private String dbFile;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbc;
    private TransactionTemplate tx;

    @org.springframework.beans.factory.annotation.Autowired
    public SqliteBoardRepository(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** For tests: a database at {@code file}. */
    SqliteBoardRepository(ObjectMapper objectMapper, String file) {
        this.objectMapper = objectMapper;
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
        // Every pragma in the URL (the driver runs only the first statement of a compound connectionInitSql).
        config.setJdbcUrl("jdbc:sqlite:" + path + "?journal_mode=WAL&synchronous=NORMAL&busy_timeout=30000&foreign_keys=true");
        config.setMaximumPoolSize(4);
        config.setPoolName("board-sqlite-pool");
        dataSource = new HikariDataSource(config);
        jdbc = new JdbcTemplate(dataSource);
        tx = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        createSchema();
        if (!Files.isWritable(path)) {
            log.error("{} is not writable - the board cannot save anything", dbFile);
            throw new IllegalStateException(dbFile + " is not writable");
        }
    }

    @PreDestroy
    public void close() {
        if (dataSource != null) {
            dataSource.close();
        }
    }

    private void createSchema() {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS cards (
                  id TEXT PRIMARY KEY, project TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
                  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, resolution TEXT, reason TEXT,
                  flags TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL, author TEXT NOT NULL, cycle_id TEXT,
                  cycle_deleted INTEGER NOT NULL DEFAULT 0, signature TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                  updated_by TEXT NOT NULL, UNIQUE (project, number))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_cards_project_status ON cards(project, status)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_cards_cycle ON cards(cycle_id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_cards_signature ON cards(signature)");
        // The highest number a project ever gave out, so a deleted card's number is never handed out again.
        jdbc.execute("CREATE TABLE IF NOT EXISTS card_numbers (project TEXT PRIMARY KEY, last INTEGER NOT NULL)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS activity (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                  actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, old_value TEXT, new_value TEXT, at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_activity_card ON activity(card_id, id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS mentions (
                  owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
                  type TEXT NOT NULL, ref TEXT NOT NULL, label TEXT NOT NULL, call_id TEXT, live INTEGER NOT NULL DEFAULT 0,
                  cycle_id TEXT)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_mentions_call ON mentions(call_id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_mentions_cycle_call ON mentions(cycle_id, call_id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_mentions_card ON mentions(card_id)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_mentions_owner ON mentions(owner_type, owner_id)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS cycle_briefs (cycle_id TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS spec_files (cycle_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
                  size INTEGER NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY (cycle_id, name))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS checklist_marks (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL,
                  mark TEXT NOT NULL, actor TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', history TEXT NOT NULL DEFAULT '[]',
                  updated_at INTEGER NOT NULL, PRIMARY KEY (cycle_id, file_name, item_key))
                """);
        // Claude's open proposal per card (Verified, Done, closing) and its suggested checklist marks - both wait for the user.
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS proposals (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
                  status TEXT NOT NULL, resolution TEXT, reason TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
                  at INTEGER NOT NULL)
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS checklist_suggestions (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL,
                  mark TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, PRIMARY KEY (cycle_id, file_name, item_key))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity(actor, id)");
        // Replies (one level): the comment an entry answers. Added in place to a board.db made before replies existed.
        addColumn("activity", "reply_to", "INTEGER");
        // Who a card waits on (specs/015): set by the services' rules and by Claude.
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS card_waiting (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
                  waiting_on TEXT NOT NULL, since INTEGER NOT NULL, set_by TEXT NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_card_waiting ON card_waiting(waiting_on, since)");
        // Claude may write briefs and spec files (specs/015): who wrote it, and the version it replaced (Restore previous).
        addColumn("cycle_briefs", "updated_by", "TEXT NOT NULL DEFAULT 'USER'");
        addColumn("cycle_briefs", "prev_text", "TEXT");
        addColumn("cycle_briefs", "prev_at", "INTEGER");
        addColumn("cycle_briefs", "prev_by", "TEXT");
        addColumn("spec_files", "uploaded_by", "TEXT NOT NULL DEFAULT 'USER'");
        addColumn("spec_files", "prev_content", "TEXT");
        addColumn("spec_files", "prev_size", "INTEGER");
        addColumn("spec_files", "prev_at", "INTEGER");
        addColumn("spec_files", "prev_by", "TEXT");
        // Merge and reopen proposals (specs/015 FR-15, FR-17).
        addColumn("proposals", "kind", "TEXT NOT NULL DEFAULT 'STATUS'");
        addColumn("proposals", "into_card", "TEXT");
        addColumn("proposals", "into_number", "INTEGER");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS card_blocks (card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                  blocked_by TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, PRIMARY KEY (card_id, blocked_by))
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS card_spec_items (card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, cycle_id TEXT NOT NULL,
                  file_name TEXT NOT NULL, item_key TEXT NOT NULL, PRIMARY KEY (card_id, cycle_id, file_name, item_key))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_card_spec_items_cycle ON card_spec_items(cycle_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS cycle_log (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT NOT NULL, skill TEXT NOT NULL,
                  did TEXT NOT NULL, found TEXT NOT NULL, next TEXT NOT NULL, at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_cycle_log ON cycle_log(cycle_id, id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS cycle_steps (cycle_id TEXT NOT NULL, step_key TEXT NOT NULL, state TEXT NOT NULL,
                  calls INTEGER NOT NULL DEFAULT 0, card_number INTEGER, note TEXT, at INTEGER NOT NULL, PRIMARY KEY (cycle_id, step_key))
                """);
        // specs/016: re-test plans, recorded re-tests, app starts
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS retest_plans (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
                  plan_json TEXT NOT NULL, updated_by TEXT, updated_at INTEGER)
                """);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS retest_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                  number INTEGER NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, verdict TEXT NOT NULL,
                  calls INTEGER NOT NULL, summary TEXT NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_retest_runs ON retest_runs(card_id, id)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS app_starts (project TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    }

    /** Adds a column to a table made by an older version (SQLite has no ADD COLUMN IF NOT EXISTS). */
    private void addColumn(String table, String column, String definition) {
        Integer has = jdbc.queryForObject("SELECT COUNT(*) FROM pragma_table_info('" + table + "') WHERE name = ?", Integer.class, column);
        if (has == null || has == 0) {
            jdbc.execute("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------- cards

    @Override
    public int nextNumber(String project) {
        Integer next = tx.execute(status -> {
            Integer last = jdbc.query("SELECT last FROM card_numbers WHERE project = ?", rs -> rs.next() ? rs.getInt(1) : null, project);
            Integer max = jdbc.queryForObject("SELECT COALESCE(MAX(number), 0) FROM cards WHERE project = ?", Integer.class, project);
            int n = Math.max(last == null ? 0 : last, max == null ? 0 : max) + 1;
            jdbc.update("INSERT INTO card_numbers(project, last) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET last = excluded.last",
                    project, n);
            return n;
        });
        return next == null ? 1 : next;
    }

    @Override
    public void insert(Card c) {
        jdbc.update("INSERT INTO cards(" + DETAIL_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values(c));
    }

    @Override
    public void update(Card c) {
        jdbc.update("""
                UPDATE cards SET project = ?, number = ?, kind = ?, title = ?, status = ?, resolution = ?, reason = ?, flags = ?,
                  scope = ?, author = ?, cycle_id = ?, cycle_deleted = ?, signature = ?, created_at = ?, updated_at = ?,
                  updated_by = ?, description = ? WHERE id = ?
                """, c.project(), c.number(), c.kind().name(), c.title(), c.status().name(), name(c.resolution()), c.reason(),
                flagsText(c.flags()), c.scope().name(), c.author().name(), c.cycleId(), c.cycleDeleted() ? 1 : 0, c.signature(),
                c.createdAt().toEpochMilli(), c.updatedAt().toEpochMilli(), c.updatedBy().name(), c.description(), c.id());
    }

    private Object[] values(Card c) {
        return new Object[]{c.id(), c.project(), c.number(), c.kind().name(), c.title(), c.status().name(), name(c.resolution()),
                c.reason(), flagsText(c.flags()), c.scope().name(), c.author().name(), c.cycleId(), c.cycleDeleted() ? 1 : 0,
                c.signature(), c.createdAt().toEpochMilli(), c.updatedAt().toEpochMilli(), c.updatedBy().name(), c.description()};
    }

    @Override
    public Optional<Card> find(String id) {
        return jdbc.query("SELECT " + DETAIL_COLUMNS + " FROM cards WHERE id = ?", DETAIL_ROW, id).stream().findFirst();
    }

    @Override
    public Optional<Card> findByNumber(String project, int number) {
        return jdbc.query("SELECT " + DETAIL_COLUMNS + " FROM cards WHERE project = ? AND number = ?", DETAIL_ROW, project, number)
                .stream().findFirst();
    }

    @Override
    public boolean delete(String id) {
        return jdbc.update("DELETE FROM cards WHERE id = ?", id) > 0;
    }

    @Override
    public List<Card> query(CardQuery q) {
        List<Object> args = new ArrayList<>();
        String where = where(q, args);
        args.add(q.limit());
        args.add(q.offset());
        // Newest change first inside each status; the board groups by status itself.
        return jdbc.query("SELECT " + SUMMARY_COLUMNS + " FROM cards" + where + " ORDER BY updated_at DESC, number DESC LIMIT ? OFFSET ?",
                SUMMARY_ROW, args.toArray());
    }

    @Override
    public int count(CardQuery q) {
        List<Object> args = new ArrayList<>();
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM cards" + where(q, args), Integer.class, args.toArray());
        return n == null ? 0 : n;
    }

    private static String where(CardQuery q, List<Object> args) {
        List<String> parts = new ArrayList<>();
        if (q.cycleId() != null) {
            parts.add("cycle_id = ?");
            args.add(q.cycleId());
        } else if (!q.allProjects()) {
            parts.add("project = ?");
            args.add(q.project() == null ? "" : q.project());
        }
        if (q.since() != null) {
            parts.add("updated_at >= ?");
            args.add(q.since().toEpochMilli());
        }
        if (q.waiting() != null) {
            parts.add("EXISTS (SELECT 1 FROM card_waiting w WHERE w.card_id = cards.id AND w.waiting_on = ?)");
            args.add(q.waiting().name());
        }
        if (q.claudeTouched()) {
            parts.add("(author = 'CLAUDE' OR EXISTS (SELECT 1 FROM activity a WHERE a.card_id = cards.id AND a.actor = 'CLAUDE'))");
        }
        in(parts, args, "kind", q.kinds().stream().map(Enum::name).toList());
        in(parts, args, "status", q.statuses().stream().map(Enum::name).toList());
        for (Flag f : q.flags()) {
            parts.add("(',' || flags || ',') LIKE ?");
            args.add("%," + f.name() + ",%");
        }
        if (q.author() != null) {
            parts.add("author = ?");
            args.add(q.author().name());
        }
        if (q.scopeNotDecided()) {
            parts.add("scope = 'NOT_DECIDED' AND status <> 'CLOSED'");
        }
        if (q.q() != null) {
            parts.add("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
            String like = "%" + q.q().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
            args.add(like);
            args.add(like);
        }
        return parts.isEmpty() ? "" : " WHERE " + String.join(" AND ", parts);
    }

    private static void in(List<String> parts, List<Object> args, String column, List<String> values) {
        if (values.isEmpty()) {
            return;
        }
        parts.add(column + " IN (" + values.stream().map(v -> "?").collect(Collectors.joining(",")) + ")");
        args.addAll(values);
    }

    @Override
    public CardsPage.Progress progress(String project, String cycleId) {
        String where = cycleId != null ? "cycle_id = ?" : "project = ?";
        Object arg = cycleId != null ? cycleId : (project == null ? "" : project);
        Map<String, Integer> byStatus = new HashMap<>();
        jdbc.query("SELECT status, COUNT(*) FROM cards WHERE " + where + " GROUP BY status",
                rs -> {
                    byStatus.put(rs.getString(1), rs.getInt(2));
                }, arg);
        int open = sum(byStatus, "INBOX", "TO_DO", "IN_PROGRESS");
        int fixed = sum(byStatus, "FIXED", "VERIFIED");
        int done = sum(byStatus, "DONE", "CLOSED");
        return new CardsPage.Progress(open, fixed, done);
    }

    private static int sum(Map<String, Integer> m, String... keys) {
        int n = 0;
        for (String k : keys) {
            n += m.getOrDefault(k, 0);
        }
        return n;
    }

    // ------------------------------------------------------------------------------------------------------------- activity

    @Override
    public long append(ActivityEntry e) {
        return tx.execute(status -> {
            jdbc.update("INSERT INTO activity(card_id, actor, kind, text, old_value, new_value, at, reply_to) VALUES (?,?,?,?,?,?,?,?)",
                    e.cardId(), e.actor().name(), e.kind().name(), e.text(), e.oldValue(), e.newValue(), e.at().toEpochMilli(), e.replyTo());
            Long id = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            return id == null ? 0L : id;
        });
    }

    @Override
    public List<ActivityEntry> activity(String cardId, int offset, int limit) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to FROM activity WHERE card_id = ? "
                + "ORDER BY id LIMIT ? OFFSET ?", ACTIVITY_ROW, cardId, limit, offset);
    }

    @Override
    public int activityCount(String cardId) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM activity WHERE card_id = ?", Integer.class, cardId);
        return n == null ? 0 : n;
    }

    @Override
    public Map<String, Integer> commentCounts(Collection<String> cardIds) {
        Map<String, Integer> out = new HashMap<>();
        for (List<String> chunk : chunks(cardIds)) {
            jdbc.query("SELECT card_id, COUNT(*) FROM activity WHERE kind = 'COMMENT' AND card_id IN (" + marks(chunk.size())
                    + ") GROUP BY card_id", rs -> {
                        out.put(rs.getString(1), rs.getInt(2));
                    }, chunk.toArray());
        }
        return out;
    }

    @Override
    public Optional<ActivityEntry> lastOf(String cardId, String kind) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to FROM activity WHERE card_id = ? AND kind = ? "
                + "ORDER BY id DESC LIMIT 1", ACTIVITY_ROW, cardId, kind).stream().findFirst();
    }

    @Override
    public Optional<ActivityEntry> activityEntry(long id) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to FROM activity WHERE id = ?", ACTIVITY_ROW, id)
                .stream().findFirst();
    }

    @Override
    public List<ActivityEntry> after(String cardId, long afterId) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to FROM activity WHERE card_id = ? AND id > ? "
                + "ORDER BY id LIMIT 1000", ACTIVITY_ROW, cardId, afterId);
    }

    @Override
    public Map<String, ActivityEntry> lastComments(Collection<String> cardIds) {
        Map<String, ActivityEntry> out = new HashMap<>();
        for (List<String> chunk : chunks(cardIds)) {
            jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to FROM activity WHERE id IN (SELECT MAX(id) FROM activity "
                    + "WHERE kind = 'COMMENT' AND card_id IN (" + marks(chunk.size()) + ") GROUP BY card_id)", rs -> {
                        ActivityEntry e = ACTIVITY_ROW.mapRow(rs, 0);
                        out.put(e.cardId(), e);
                    }, chunk.toArray());
        }
        return out;
    }

    @Override
    public List<BoardChanges.Entry> activityAfter(long afterId, String project, String cycleId, Actor actor, int limit) {
        List<Object> args = new ArrayList<>();
        args.add(afterId);
        StringBuilder sql = new StringBuilder("SELECT a.id, a.card_id, a.actor, a.kind, a.text, a.old_value, a.new_value, a.at, a.reply_to, "
                + "c.project, c.number, c.title, c.status, c.cycle_id FROM activity a JOIN cards c ON c.id = a.card_id WHERE a.id > ?");
        if (project != null) {
            sql.append(" AND c.project = ?");
            args.add(project);
        }
        if (cycleId != null) {
            sql.append(" AND c.cycle_id = ?");
            args.add(cycleId);
        }
        if (actor != null) {
            sql.append(" AND a.actor = ?");
            args.add(actor.name());
        }
        sql.append(" ORDER BY a.id LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> new BoardChanges.Entry(ACTIVITY_ROW.mapRow(rs, n), rs.getString(10), rs.getInt(11),
                rs.getString(12), CardStatus.valueOf(rs.getString(13)), rs.getString(14)), args.toArray());
    }

    @Override
    public long lastActivityId() {
        Long n = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM activity", Long.class);
        return n == null ? 0 : n;
    }

    @Override
    public long lastActivityIdBy(Actor actor, String project) {
        Long n = project == null
                ? jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM activity WHERE actor = ?", Long.class, actor.name())
                : jdbc.queryForObject("SELECT COALESCE(MAX(a.id), 0) FROM activity a JOIN cards c ON c.id = a.card_id "
                        + "WHERE a.actor = ? AND c.project = ?", Long.class, actor.name(), project);
        return n == null ? 0 : n;
    }

    private static final String CYCLE_CHANGES = "SELECT cycle_id, 'brief' AS what, NULL AS name, NULL AS detail, updated_at AS at FROM cycle_briefs "
            + "WHERE updated_at > ? UNION ALL SELECT cycle_id, 'spec', name, NULL, uploaded_at FROM spec_files WHERE uploaded_at > ? "
            + "UNION ALL SELECT cycle_id, 'mark', file_name, item_key || ' ' || mark, updated_at FROM checklist_marks WHERE updated_at > ? "
            + "UNION ALL SELECT cycle_id, 'suggestion', file_name, item_key || ' ' || mark, at FROM checklist_suggestions WHERE at > ?";

    @Override
    public List<BoardChanges.CycleChange> cycleChangesAfter(long afterMillis, String project, String cycleId, int limit) {
        List<Object> args = new ArrayList<>(List.of(afterMillis, afterMillis, afterMillis, afterMillis));
        StringBuilder sql = new StringBuilder("SELECT cycle_id, what, name, detail, at FROM (" + CYCLE_CHANGES + ")");
        if (cycleId != null) {
            sql.append(" WHERE cycle_id = ?");
            args.add(cycleId);
        } else if (project != null) {
            sql.append(" WHERE cycle_id IN (SELECT DISTINCT cycle_id FROM cards WHERE project = ? AND cycle_id IS NOT NULL)");
            args.add(project);
        }
        sql.append(" ORDER BY at LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> new BoardChanges.CycleChange(rs.getString(1), rs.getString(2), rs.getString(3),
                rs.getString(4), Instant.ofEpochMilli(rs.getLong(5))), args.toArray());
    }

    @Override
    public long lastCycleChangeMillis() {
        Long n = jdbc.queryForObject("SELECT COALESCE(MAX(at), 0) FROM (" + CYCLE_CHANGES + ")", Long.class, -1L, -1L, -1L, -1L);
        return n == null ? 0 : n;
    }

    // ------------------------------------------------------------------------------------------------------------- mentions

    @Override
    public void replaceMentions(MentionOwner owner, String ownerId, String cardId, List<MentionRef> refs) {
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM mentions WHERE owner_type = ? AND owner_id = ?", owner.name(), ownerId);
            for (MentionRef ref : refs) {
                insertMention(owner, ownerId, cardId, ref);
            }
        });
    }

    private void insertMention(MentionOwner owner, String ownerId, String cardId, MentionRef ref) {
        jdbc.update("INSERT INTO mentions(owner_type, owner_id, card_id, type, ref, label, call_id, live, cycle_id) VALUES (?,?,?,?,?,?,?,?,?)",
                owner.name(), ownerId, cardId, ref.typeName(), ref.ref(), ref.label(), ref.callId(), ref.liveCallId() != null ? 1 : 0,
                ref.cycleId());
    }

    @Override
    public void addDirect(String cardId, MentionRef ref) {
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM mentions WHERE owner_type = 'DIRECT' AND owner_id = ? AND type = ? AND ref = ?",
                    cardId, ref.typeName(), ref.ref());
            insertMention(MentionOwner.DIRECT, cardId, cardId, ref);
        });
    }

    @Override
    public boolean removeDirect(String cardId, String type, String ref) {
        return jdbc.update("DELETE FROM mentions WHERE owner_type = 'DIRECT' AND owner_id = ? AND type = ? AND ref = ?", cardId, type, ref) > 0;
    }

    @Override
    public List<MentionRef> linksOf(String cardId) {
        LinkedHashMap<String, MentionRef> out = new LinkedHashMap<>();
        jdbc.query("SELECT type, ref, label FROM mentions WHERE card_id = ? ORDER BY rowid LIMIT 5000", rs -> {
            MentionRef ref = ref(rs);
            out.putIfAbsent(ref.typeName() + ":" + ref.ref(), ref);
        }, cardId);
        return List.copyOf(out.values());
    }

    @Override
    public Map<String, List<MentionRef>> chipsOf(Collection<String> cardIds, int perCard) {
        Map<String, LinkedHashMap<String, MentionRef>> out = new HashMap<>();
        for (List<String> chunk : chunks(cardIds)) {
            jdbc.query("SELECT card_id, type, ref, label FROM mentions WHERE card_id IN (" + marks(chunk.size()) + ") ORDER BY rowid",
                    rs -> {
                        LinkedHashMap<String, MentionRef> mine = out.computeIfAbsent(rs.getString(1), k -> new LinkedHashMap<>());
                        if (mine.size() < perCard) {
                            MentionRef ref = ref(rs);
                            mine.putIfAbsent(ref.typeName() + ":" + ref.ref(), ref);
                        }
                    }, chunk.toArray());
        }
        Map<String, List<MentionRef>> result = new HashMap<>();
        out.forEach((k, v) -> result.put(k, List.copyOf(v.values())));
        return result;
    }

    @Override
    public Set<String> mentionedLiveCallIds() {
        return new LinkedHashSet<>(jdbc.queryForList("SELECT DISTINCT call_id FROM mentions WHERE live = 1 AND call_id IS NOT NULL", String.class));
    }

    @Override
    public List<String> cardsMentioningSpec(String cycleId, String name) {
        String ref = cycleId + "/" + name;
        String like = ref.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "#%";
        return jdbc.queryForList("SELECT DISTINCT card_id FROM mentions WHERE card_id IS NOT NULL AND type = 'spec' "
                + "AND (ref = ? OR ref LIKE ? ESCAPE '\\') LIMIT 5000", String.class, ref, like);
    }

    @Override
    public Map<String, List<CallBadge>> badgesOfCycle(String cycleId) {
        return badges("SELECT DISTINCT m.call_id, c.project, c.number, c.kind, c.status, c.resolution, c.title FROM mentions m "
                + "JOIN cards c ON c.id = m.card_id WHERE m.call_id IS NOT NULL AND (m.cycle_id = ? OR c.cycle_id = ?) "
                + "ORDER BY c.number LIMIT " + BADGE_ROWS, cycleId, cycleId);
    }

    @Override
    public Map<String, List<CallBadge>> badgesOfCalls(Collection<String> callIds) {
        Map<String, List<CallBadge>> out = new LinkedHashMap<>();
        for (List<String> chunk : chunks(callIds)) {
            out.putAll(badges("SELECT DISTINCT m.call_id, c.project, c.number, c.kind, c.status, c.resolution, c.title FROM mentions m "
                    + "JOIN cards c ON c.id = m.card_id WHERE m.call_id IN (" + marks(chunk.size()) + ") ORDER BY c.number LIMIT "
                    + BADGE_ROWS, chunk.toArray()));
        }
        return out;
    }

    private Map<String, List<CallBadge>> badges(String sql, Object... args) {
        Map<String, List<CallBadge>> out = new LinkedHashMap<>();
        jdbc.query(sql, rs -> {
            out.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(new CallBadge(rs.getString(2), rs.getInt(3),
                    CardKind.valueOf(rs.getString(4)), CardStatus.valueOf(rs.getString(5)), resolution(rs.getString(6)), rs.getString(7)));
        }, args);
        return out;
    }

    // ------------------------------------------------------------------------------------------------- similarity / Claude

    @Override
    public Map<String, SimilarClosed> closedBySignature(String project, Collection<String> signatures) {
        Map<String, SimilarClosed> out = new HashMap<>();
        for (List<String> chunk : chunks(new LinkedHashSet<>(signatures))) {
            List<Object> args = new ArrayList<>();
            args.add(project == null ? "" : project);
            args.addAll(chunk);
            jdbc.query("SELECT signature, number, title, resolution, reason FROM cards WHERE project = ? AND status = 'CLOSED' "
                    + "AND signature IN (" + marks(chunk.size()) + ") ORDER BY updated_at DESC", rs -> {
                        out.putIfAbsent(rs.getString(1), new SimilarClosed(rs.getInt(2), rs.getString(3), resolution(rs.getString(4)),
                                rs.getString(5)));
                    }, args.toArray());
        }
        return out;
    }

    @Override
    public List<ClosedReason> closedReasons(String project, int limit) {
        return jdbc.query("SELECT number, title, signature, resolution, reason FROM cards WHERE project = ? AND status = 'CLOSED' "
                        + "ORDER BY updated_at DESC LIMIT ?",
                (rs, n) -> new ClosedReason(rs.getInt(1), rs.getString(2), rs.getString(3), resolution(rs.getString(4)), rs.getString(5)),
                project == null ? "" : project, limit);
    }

    @Override
    public List<Card> similar(String project, String signature, List<String> words, int limit) {
        List<String> ors = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (signature != null) {
            ors.add("signature = ?");
            args.add(signature);
        }
        for (String w : words) {
            ors.add("title LIKE ? ESCAPE '\\'");
            args.add("%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
        }
        if (ors.isEmpty()) {
            return List.of();
        }
        String where = "(" + String.join(" OR ", ors) + ")";
        if (project != null) {
            where = "project = ? AND " + where;
            args.add(0, project);
        }
        args.add(limit);
        return jdbc.query("SELECT " + SUMMARY_COLUMNS + " FROM cards WHERE " + where + " ORDER BY updated_at DESC LIMIT ?", SUMMARY_ROW,
                args.toArray());
    }

    // ----------------------------------------------------------------------------------------------------------- waiting on

    private static final RowMapper<WaitingOn> WAITING_ROW = (rs, n) -> new WaitingOn(Waiting.valueOf(rs.getString(2)),
            Instant.ofEpochMilli(rs.getLong(3)), Actor.valueOf(rs.getString(4)));

    @Override
    public Optional<WaitingOn> waiting(String cardId) {
        return jdbc.query("SELECT card_id, waiting_on, since, set_by FROM card_waiting WHERE card_id = ?", WAITING_ROW, cardId).stream().findFirst();
    }

    @Override
    public Map<String, WaitingOn> waitings(Collection<String> cardIds) {
        Map<String, WaitingOn> out = new HashMap<>();
        for (List<String> chunk : chunks(cardIds)) {
            jdbc.query("SELECT card_id, waiting_on, since, set_by FROM card_waiting WHERE card_id IN (" + marks(chunk.size()) + ")", rs -> {
                out.put(rs.getString(1), WAITING_ROW.mapRow(rs, 0));
            }, chunk.toArray());
        }
        return out;
    }

    @Override
    public void setWaiting(String cardId, WaitingOn w) {
        jdbc.update("INSERT INTO card_waiting(card_id, waiting_on, since, set_by) VALUES (?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET "
                + "waiting_on = excluded.waiting_on, since = excluded.since, set_by = excluded.set_by", cardId, w.who().name(),
                w.since().toEpochMilli(), w.setBy().name());
    }

    @Override
    public NextSteps nextSteps(String project, String cycleId) {
        String scope = cycleId != null ? "c.cycle_id = ?" : "c.project = ?";
        Object arg = cycleId != null ? cycleId : (project == null ? "" : project);
        List<NextSteps.Item> mine = jdbc.query("SELECT c.project, c.number, c.title, c.status, w.since, CASE "
                        + "WHEN EXISTS (SELECT 1 FROM proposals p WHERE p.card_id = c.id) THEN 'proposal' "
                        + "WHEN (',' || c.flags || ',') LIKE '%,NEEDS_DECISION,%' THEN 'question' "
                        + "WHEN c.status = 'INBOX' THEN 'inbox' ELSE 'other' END "
                        + "FROM cards c JOIN card_waiting w ON w.card_id = c.id WHERE w.waiting_on = 'USER' AND " + scope
                        + " ORDER BY w.since LIMIT 50",
                (rs, n) -> new NextSteps.Item(rs.getString(1), rs.getInt(2), rs.getString(3), CardStatus.valueOf(rs.getString(4)),
                        rs.getString(6), Instant.ofEpochMilli(rs.getLong(5))), arg);
        Integer claude = jdbc.queryForObject("SELECT COUNT(*) FROM cards c JOIN card_waiting w ON w.card_id = c.id "
                + "WHERE w.waiting_on = 'CLAUDE' AND " + scope, Integer.class, arg);
        Map<String, Integer> byStatus = new HashMap<>();
        jdbc.query("SELECT c.status, COUNT(*) FROM cards c WHERE " + scope + " GROUP BY c.status", rs -> {
            byStatus.put(rs.getString(1), rs.getInt(2));
        }, arg);
        return new NextSteps(mine, claude == null ? 0 : claude, byStatus.getOrDefault("TO_DO", 0), byStatus.getOrDefault("IN_PROGRESS", 0),
                byStatus.getOrDefault("FIXED", 0), byStatus.getOrDefault("INBOX", 0));
    }

    // ------------------------------------------------------------------------------------------------------------- proposals

    private static final String PROPOSAL_COLUMNS = "card_id, status, resolution, reason, evidence, at, kind, into_card, into_number";

    private static final RowMapper<Proposal> PROPOSAL_ROW = (rs, n) -> new Proposal(rs.getString(1), CardStatus.valueOf(rs.getString(2)),
            resolution(rs.getString(3)), rs.getString(4), rs.getString(5), Instant.ofEpochMilli(rs.getLong(6)),
            Proposal.Kind.valueOf(rs.getString(7)), rs.getString(8), rs.getObject(9) == null ? null : rs.getInt(9));

    @Override
    public Optional<Proposal> proposal(String cardId) {
        return jdbc.query("SELECT " + PROPOSAL_COLUMNS + " FROM proposals WHERE card_id = ?", PROPOSAL_ROW, cardId)
                .stream().findFirst();
    }

    @Override
    public Map<String, Proposal> proposals(Collection<String> cardIds) {
        Map<String, Proposal> out = new HashMap<>();
        for (List<String> chunk : chunks(cardIds)) {
            jdbc.query("SELECT " + PROPOSAL_COLUMNS + " FROM proposals WHERE card_id IN (" + marks(chunk.size()) + ")",
                    rs -> {
                        Proposal p = PROPOSAL_ROW.mapRow(rs, 0);
                        out.put(p.cardId(), p);
                    }, chunk.toArray());
        }
        return out;
    }

    @Override
    public void putProposal(Proposal p) {
        jdbc.update("INSERT INTO proposals(" + PROPOSAL_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE "
                        + "SET status = excluded.status, resolution = excluded.resolution, reason = excluded.reason, evidence = excluded.evidence, "
                        + "at = excluded.at, kind = excluded.kind, into_card = excluded.into_card, into_number = excluded.into_number",
                p.cardId(), p.status().name(), name(p.resolution()), p.reason(), p.evidence(), p.at().toEpochMilli(), p.kind().name(),
                p.intoCardId(), p.intoNumber());
    }

    @Override
    public boolean deleteProposal(String cardId) {
        return jdbc.update("DELETE FROM proposals WHERE card_id = ?", cardId) > 0;
    }

    // ---------------------------------------------------------------------------------------- blocks, spec items, merge

    private static final RowMapper<CardRef> CARD_REF = (rs, n) -> new CardRef(rs.getString(2), rs.getInt(3), rs.getString(4),
            CardStatus.valueOf(rs.getString(5)));

    @Override
    public void addBlock(String cardId, String blockedById) {
        jdbc.update("INSERT OR IGNORE INTO card_blocks(card_id, blocked_by) VALUES (?,?)", cardId, blockedById);
    }

    @Override
    public boolean removeBlock(String cardId, String blockedById) {
        return jdbc.update("DELETE FROM card_blocks WHERE card_id = ? AND blocked_by = ?", cardId, blockedById) > 0;
    }

    @Override
    public Map<String, List<CardRef>> blockersOf(Collection<String> cardIds) {
        Map<String, List<CardRef>> out = new HashMap<>();
        for (List<String> chunk : chunks(cardIds)) {
            jdbc.query("SELECT b.card_id, c.project, c.number, c.title, c.status FROM card_blocks b JOIN cards c ON c.id = b.blocked_by "
                    + "WHERE b.card_id IN (" + marks(chunk.size()) + ") ORDER BY c.number", rs -> {
                        out.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(CARD_REF.mapRow(rs, 0));
                    }, chunk.toArray());
        }
        return out;
    }

    @Override
    public void addSpecItem(String cardId, String cycleId, String fileName, String itemKey) {
        jdbc.update("INSERT OR IGNORE INTO card_spec_items(card_id, cycle_id, file_name, item_key) VALUES (?,?,?,?)", cardId, cycleId, fileName, itemKey);
    }

    @Override
    public boolean removeSpecItem(String cardId, String cycleId, String fileName, String itemKey) {
        return jdbc.update("DELETE FROM card_spec_items WHERE card_id = ? AND cycle_id = ? AND file_name = ? AND item_key = ?",
                cardId, cycleId, fileName, itemKey) > 0;
    }

    @Override
    public List<String[]> specItemsOf(String cardId) {
        return jdbc.query("SELECT cycle_id, file_name, item_key FROM card_spec_items WHERE card_id = ? LIMIT 200",
                (rs, n) -> new String[]{rs.getString(1), rs.getString(2), rs.getString(3)}, cardId);
    }

    @Override
    public Map<String, List<CardRef>> cardsBySpecItem(String cycleId) {
        Map<String, List<CardRef>> out = new HashMap<>();
        jdbc.query("SELECT s.file_name || char(10) || s.item_key, c.project, c.number, c.title, c.status FROM card_spec_items s "
                + "JOIN cards c ON c.id = s.card_id WHERE s.cycle_id = ? ORDER BY c.number LIMIT 5000", rs -> {
                    out.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(CARD_REF.mapRow(rs, 0));
                }, cycleId);
        return out;
    }

    @Override
    public void mergeInto(String sourceId, String targetId) {
        tx.executeWithoutResult(status -> {
            jdbc.update("UPDATE activity SET card_id = ? WHERE card_id = ?", targetId, sourceId);
            jdbc.update("UPDATE mentions SET card_id = ? WHERE card_id = ?", targetId, sourceId);
            jdbc.update("UPDATE mentions SET owner_id = ? WHERE owner_type = 'DIRECT' AND owner_id = ?", targetId, sourceId);
            jdbc.update("UPDATE mentions SET owner_id = ? WHERE owner_type = 'CARD' AND owner_id = ?", targetId, sourceId);
            jdbc.update("INSERT OR IGNORE INTO card_spec_items(card_id, cycle_id, file_name, item_key) "
                    + "SELECT ?, cycle_id, file_name, item_key FROM card_spec_items WHERE card_id = ?", targetId, sourceId);
            jdbc.update("DELETE FROM card_spec_items WHERE card_id = ?", sourceId);
            jdbc.update("INSERT OR IGNORE INTO card_blocks(card_id, blocked_by) SELECT ?, blocked_by FROM card_blocks WHERE card_id = ? "
                    + "AND blocked_by <> ?", targetId, sourceId, targetId);
            jdbc.update("DELETE FROM card_blocks WHERE card_id = ?", sourceId);
            jdbc.update("UPDATE OR IGNORE card_blocks SET blocked_by = ? WHERE blocked_by = ? AND card_id <> ?", targetId, sourceId, targetId);
            jdbc.update("DELETE FROM card_blocks WHERE blocked_by = ?", sourceId);
        });
    }

    // ------------------------------------------------------------------------------------------- session log, test steps

    @Override
    public long appendLog(SessionLogEntry e) {
        return tx.execute(status -> {
            jdbc.update("INSERT INTO cycle_log(cycle_id, skill, did, found, next, at) VALUES (?,?,?,?,?,?)", e.cycleId(), e.skill(), e.did(),
                    e.found(), e.next(), e.at().toEpochMilli());
            Long id = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            return id == null ? 0L : id;
        });
    }

    @Override
    public List<SessionLogEntry> log(String cycleId, int limit) {
        return jdbc.query("SELECT id, cycle_id, skill, did, found, next, at FROM cycle_log WHERE cycle_id = ? ORDER BY id DESC LIMIT ?",
                (rs, n) -> new SessionLogEntry(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6),
                        Instant.ofEpochMilli(rs.getLong(7))), cycleId, limit);
    }

    @Override
    public List<TestStep> stepMarks(String cycleId) {
        return jdbc.query("SELECT step_key, state, calls, card_number, note, at FROM cycle_steps WHERE cycle_id = ? LIMIT 1000",
                (rs, n) -> new TestStep(rs.getString(1), null, StepState.valueOf(rs.getString(2)), rs.getInt(3),
                        rs.getObject(4) == null ? null : rs.getInt(4), rs.getString(5), Instant.ofEpochMilli(rs.getLong(6))), cycleId);
    }

    @Override
    public void putStepMark(String cycleId, String stepKey, StepState state, int calls, Integer cardNumber, String note, Instant at) {
        jdbc.update("INSERT INTO cycle_steps(cycle_id, step_key, state, calls, card_number, note, at) VALUES (?,?,?,?,?,?,?) "
                + "ON CONFLICT(cycle_id, step_key) DO UPDATE SET state = excluded.state, calls = excluded.calls, card_number = excluded.card_number, "
                + "note = excluded.note, at = excluded.at", cycleId, stepKey, state.name(), calls, cardNumber, note, at.toEpochMilli());
    }

    // ---------------------------------------------------------------------------------------- brief, spec files, checklist

    @Override
    public Optional<CycleBrief> brief(String cycleId) {
        return jdbc.query("SELECT cycle_id, text, updated_at, updated_by, prev_text IS NOT NULL FROM cycle_briefs WHERE cycle_id = ?",
                (rs, n) -> new CycleBrief(rs.getString(1), rs.getString(2), Instant.ofEpochMilli(rs.getLong(3)), Actor.valueOf(rs.getString(4)),
                        rs.getInt(5) == 1), cycleId).stream().findFirst();
    }

    @Override
    public void putBrief(CycleBrief b) {
        // The text it replaces is kept once, for Restore previous.
        jdbc.update("INSERT INTO cycle_briefs(cycle_id, text, updated_at, updated_by) VALUES (?,?,?,?) "
                + "ON CONFLICT(cycle_id) DO UPDATE SET prev_text = cycle_briefs.text, prev_at = cycle_briefs.updated_at, "
                + "prev_by = cycle_briefs.updated_by, text = excluded.text, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                b.cycleId(), b.text(), b.updatedAt().toEpochMilli(), b.updatedBy().name());
    }

    @Override
    public List<SpecFileInfo> specs(String cycleId) {
        return jdbc.query("SELECT name, size, uploaded_at, uploaded_by, prev_content IS NOT NULL FROM spec_files WHERE cycle_id = ? "
                        + "ORDER BY name LIMIT 1000",
                (rs, n) -> new SpecFileInfo(rs.getString(1), rs.getLong(2), Instant.ofEpochMilli(rs.getLong(3)), Actor.valueOf(rs.getString(4)),
                        rs.getInt(5) == 1), cycleId);
    }

    @Override
    public Optional<SpecFile> spec(String cycleId, String name) {
        return jdbc.query("SELECT cycle_id, name, content, size, uploaded_at, uploaded_by FROM spec_files WHERE cycle_id = ? AND name = ?",
                (rs, n) -> new SpecFile(rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4),
                        Instant.ofEpochMilli(rs.getLong(5)), Actor.valueOf(rs.getString(6))), cycleId, name).stream().findFirst();
    }

    @Override
    public boolean putSpec(SpecFile f) {
        Boolean replaced = tx.execute(status -> {
            Integer existing = jdbc.queryForObject("SELECT COUNT(*) FROM spec_files WHERE cycle_id = ? AND name = ?", Integer.class,
                    f.cycleId(), f.name());
            jdbc.update("INSERT INTO spec_files(cycle_id, name, content, size, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?) "
                    + "ON CONFLICT(cycle_id, name) DO UPDATE SET prev_content = spec_files.content, prev_size = spec_files.size, "
                    + "prev_at = spec_files.uploaded_at, prev_by = spec_files.uploaded_by, content = excluded.content, size = excluded.size, "
                    + "uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by", f.cycleId(), f.name(), f.content(), f.size(),
                    f.uploadedAt().toEpochMilli(), f.uploadedBy().name());
            return existing != null && existing > 0;
        });
        return Boolean.TRUE.equals(replaced);
    }

    @Override
    public boolean deleteSpec(String cycleId, String name) {
        return jdbc.update("DELETE FROM spec_files WHERE cycle_id = ? AND name = ?", cycleId, name) > 0;
    }

    @Override
    public boolean restoreBrief(String cycleId, Instant at) {
        // Swap: the restored text keeps its own author; the one it replaces becomes the "previous" again.
        return jdbc.update("UPDATE cycle_briefs SET text = prev_text, prev_text = text, updated_by = COALESCE(prev_by, 'USER'), "
                + "prev_by = updated_by, prev_at = updated_at, updated_at = ? WHERE cycle_id = ? AND prev_text IS NOT NULL", at.toEpochMilli(), cycleId) > 0;
    }

    @Override
    public boolean restoreSpec(String cycleId, String name, Instant at) {
        return jdbc.update("UPDATE spec_files SET content = prev_content, prev_content = content, size = prev_size, prev_size = size, "
                + "uploaded_by = COALESCE(prev_by, 'USER'), prev_by = uploaded_by, prev_at = uploaded_at, uploaded_at = ? "
                + "WHERE cycle_id = ? AND name = ? AND prev_content IS NOT NULL", at.toEpochMilli(), cycleId, name) > 0;
    }

    @Override
    public List<ChecklistMark> marks(String cycleId) {
        return jdbc.query("SELECT cycle_id, file_name, item_key, mark, actor, evidence, history, updated_at FROM checklist_marks "
                + "WHERE cycle_id = ? LIMIT 10000", MARK_ROW, cycleId);
    }

    @Override
    public Optional<ChecklistMark> mark(String cycleId, String fileName, String itemKey) {
        return jdbc.query("SELECT cycle_id, file_name, item_key, mark, actor, evidence, history, updated_at FROM checklist_marks "
                + "WHERE cycle_id = ? AND file_name = ? AND item_key = ?", MARK_ROW, cycleId, fileName, itemKey).stream().findFirst();
    }

    @Override
    public void putMark(ChecklistMark m) {
        jdbc.update("INSERT INTO checklist_marks(cycle_id, file_name, item_key, mark, actor, evidence, history, updated_at) "
                        + "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cycle_id, file_name, item_key) DO UPDATE SET mark = excluded.mark, "
                        + "actor = excluded.actor, evidence = excluded.evidence, history = excluded.history, updated_at = excluded.updated_at",
                m.cycleId(), m.fileName(), m.itemKey(), m.mark().name(), m.actor().name(), m.evidence(), historyText(m.history()),
                m.updatedAt().toEpochMilli());
    }

    private static final RowMapper<ChecklistSuggestion> SUGGESTION_ROW = (rs, n) -> new ChecklistSuggestion(rs.getString(1), rs.getString(2),
            rs.getString(3), Mark.valueOf(rs.getString(4)), rs.getString(5), Instant.ofEpochMilli(rs.getLong(6)));

    @Override
    public List<ChecklistSuggestion> suggestions(String cycleId) {
        return jdbc.query("SELECT cycle_id, file_name, item_key, mark, evidence, at FROM checklist_suggestions WHERE cycle_id = ? LIMIT 10000",
                SUGGESTION_ROW, cycleId);
    }

    @Override
    public Optional<ChecklistSuggestion> suggestion(String cycleId, String fileName, String itemKey) {
        return jdbc.query("SELECT cycle_id, file_name, item_key, mark, evidence, at FROM checklist_suggestions WHERE cycle_id = ? AND file_name = ? "
                + "AND item_key = ?", SUGGESTION_ROW, cycleId, fileName, itemKey).stream().findFirst();
    }

    @Override
    public void putSuggestion(ChecklistSuggestion s) {
        jdbc.update("INSERT INTO checklist_suggestions(cycle_id, file_name, item_key, mark, evidence, at) VALUES (?,?,?,?,?,?) "
                        + "ON CONFLICT(cycle_id, file_name, item_key) DO UPDATE SET mark = excluded.mark, evidence = excluded.evidence, at = excluded.at",
                s.cycleId(), s.fileName(), s.itemKey(), s.mark().name(), s.evidence(), s.at().toEpochMilli());
    }

    @Override
    public boolean deleteSuggestion(String cycleId, String fileName, String itemKey) {
        return jdbc.update("DELETE FROM checklist_suggestions WHERE cycle_id = ? AND file_name = ? AND item_key = ?", cycleId, fileName, itemKey) > 0;
    }

    @Override
    public void cycleRemoved(String cycleId) {
        String like = cycleId.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%";
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM cycle_briefs WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM spec_files WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM checklist_marks WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM checklist_suggestions WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM cycle_log WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM cycle_steps WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM card_spec_items WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM mentions WHERE (owner_type = 'BRIEF' AND owner_id = ?) "
                    + "OR (owner_type = 'CHECKLIST' AND owner_id LIKE ? ESCAPE '\\')", cycleId, like);
            jdbc.update("UPDATE cards SET cycle_deleted = 1 WHERE cycle_id = ?", cycleId);
        });
    }

    @Override
    public List<Mention> mentionsOf(MentionOwner owner, String ownerId) {
        return jdbc.query("SELECT owner_type, owner_id, card_id, type, ref, label FROM mentions WHERE owner_type = ? AND owner_id = ? "
                + "ORDER BY rowid LIMIT 5000", (rs, n) -> new Mention(MentionOwner.valueOf(rs.getString(1)), rs.getString(2),
                rs.getString(3), new MentionRef(MentionType.valueOf(rs.getString(4).toUpperCase(Locale.ROOT)), rs.getString(5),
                rs.getString(6))), owner.name(), ownerId);
    }

    // ------------------------------------------------------------------------------------------------------------- mapping

    private static final RowMapper<Card> SUMMARY_ROW = (rs, n) -> card(rs, "");

    private static final RowMapper<Card> DETAIL_ROW = (rs, n) -> card(rs, rs.getString("description"));

    private static Card card(ResultSet rs, String description) throws SQLException {
        return new Card(rs.getString("id"), rs.getString("project"), rs.getInt("number"), CardKind.valueOf(rs.getString("kind")),
                rs.getString("title"), description, CardStatus.valueOf(rs.getString("status")), resolution(rs.getString("resolution")),
                rs.getString("reason"), flags(rs.getString("flags")), Scope.valueOf(rs.getString("scope")),
                Actor.valueOf(rs.getString("author")), rs.getString("cycle_id"), rs.getInt("cycle_deleted") == 1,
                rs.getString("signature"), Instant.ofEpochMilli(rs.getLong("created_at")), Instant.ofEpochMilli(rs.getLong("updated_at")),
                Actor.valueOf(rs.getString("updated_by")));
    }

    private static final RowMapper<ActivityEntry> ACTIVITY_ROW = (rs, n) -> new ActivityEntry(rs.getLong(1), rs.getString(2),
            Actor.valueOf(rs.getString(3)), ActivityKind.valueOf(rs.getString(4)), rs.getString(5), rs.getString(6), rs.getString(7),
            Instant.ofEpochMilli(rs.getLong(8)), replyTo(rs));

    private static Long replyTo(ResultSet rs) throws SQLException {
        long v = rs.getLong(9);
        return rs.wasNull() ? null : v;
    }

    private final RowMapper<ChecklistMark> MARK_ROW = (rs, n) -> new ChecklistMark(rs.getString(1), rs.getString(2), rs.getString(3),
            Mark.valueOf(rs.getString(4)), Actor.valueOf(rs.getString(5)), rs.getString(6), history(rs.getString(7)),
            Instant.ofEpochMilli(rs.getLong(8)));

    private static MentionRef ref(ResultSet rs) throws SQLException {
        return new MentionRef(MentionType.valueOf(rs.getString("type").toUpperCase(Locale.ROOT)), rs.getString("ref"), rs.getString("label"));
    }

    private static Resolution resolution(String s) {
        return s == null ? null : Resolution.valueOf(s);
    }

    private static String name(Enum<?> e) {
        return e == null ? null : e.name();
    }

    private static String flagsText(Set<Flag> flags) {
        return flags.stream().sorted().map(Enum::name).collect(Collectors.joining(","));
    }

    private static Set<Flag> flags(String s) {
        if (s == null || s.isBlank()) {
            return Set.of();
        }
        EnumSet<Flag> out = EnumSet.noneOf(Flag.class);
        Arrays.stream(s.split(",")).map(String::strip).filter(x -> !x.isEmpty()).map(Flag::valueOf).forEach(out::add);
        return out;
    }

    private String historyText(List<ChecklistMark.Change> history) {
        try {
            return objectMapper.writeValueAsString(history);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not write a checklist history", e);
        }
    }

    private List<ChecklistMark.Change> history(String s) {
        try {
            return s == null || s.isBlank() ? List.of() : objectMapper.readValue(s, CHANGES);
        } catch (JsonProcessingException e) {
            log.warn("Unreadable checklist history ignored ({} chars)", s.length());
            return List.of();
        }
    }

    private static String marks(int n) {
        return String.join(",", java.util.Collections.nCopies(n, "?"));
    }

    private static List<List<String>> chunks(Collection<String> ids) {
        List<String> all = new ArrayList<>(ids);
        List<List<String>> out = new ArrayList<>();
        for (int i = 0; i < all.size(); i += IN_CHUNK) {
            out.add(all.subList(i, Math.min(all.size(), i + IN_CHUNK)));
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------- re-test (specs/016)

    private record PlanJson(List<com.fathy.alfred.backend.board.domain.model.Expectation> expectations,
                            List<com.fathy.alfred.backend.board.domain.model.RetestPlan.Step> steps) {
    }

    @Override
    public Optional<com.fathy.alfred.backend.board.domain.model.RetestPlan> retestPlan(String cardId) {
        return jdbc.query("SELECT plan_json, updated_by, updated_at FROM retest_plans WHERE card_id = ?", (rs, n) -> {
            try {
                PlanJson p = objectMapper.readValue(rs.getString(1), PlanJson.class);
                String by = rs.getString(2);
                long at = rs.getLong(3);
                return new com.fathy.alfred.backend.board.domain.model.RetestPlan(cardId, p.expectations(), p.steps(),
                        by == null ? null : Actor.valueOf(by), rs.wasNull() ? null : Instant.ofEpochMilli(at));
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                return com.fathy.alfred.backend.board.domain.model.RetestPlan.empty(cardId);
            }
        }, cardId).stream().findFirst();
    }

    @Override
    public void putRetestPlan(com.fathy.alfred.backend.board.domain.model.RetestPlan plan) {
        String json;
        try {
            json = objectMapper.writeValueAsString(new PlanJson(plan.expectations(), plan.steps()));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("Could not write a re-test plan", e);
        }
        jdbc.update("INSERT INTO retest_plans(card_id, plan_json, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET "
                        + "plan_json = excluded.plan_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
                plan.cardId(), json, plan.updatedBy() == null ? null : plan.updatedBy().name(),
                plan.updatedAt() == null ? null : plan.updatedAt().toEpochMilli());
    }

    @Override
    public long appendRetestRun(com.fathy.alfred.backend.board.domain.model.RetestRun r) {
        return tx.execute(status -> {
            jdbc.update("INSERT INTO retest_runs(card_id, number, at, actor, source, verdict, calls, summary) VALUES (?,?,?,?,?,?,?,?)", r.cardId(),
                    r.number(), r.at().toEpochMilli(), r.actor().name(), r.source(), r.verdict().name(), r.calls(), r.summary() == null ? "" : r.summary());
            Long id = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            return id == null ? 0L : id;
        });
    }

    @Override
    public List<com.fathy.alfred.backend.board.domain.model.RetestRun> retestRuns(String cardId, int limit) {
        return jdbc.query("SELECT id, card_id, number, at, actor, source, verdict, calls, summary FROM retest_runs WHERE card_id = ? ORDER BY id DESC LIMIT ?",
                (rs, n) -> new com.fathy.alfred.backend.board.domain.model.RetestRun(rs.getLong(1), rs.getString(2), rs.getInt(3),
                        Instant.ofEpochMilli(rs.getLong(4)), Actor.valueOf(rs.getString(5)), rs.getString(6),
                        com.fathy.alfred.backend.board.domain.model.RetestCheck.Verdict.valueOf(rs.getString(7)), rs.getInt(8), rs.getString(9)),
                cardId, limit);
    }

    @Override
    public void putAppStart(String project, Instant at) {
        jdbc.update("INSERT INTO app_starts(project, at) VALUES (?,?) ON CONFLICT(project) DO UPDATE SET at = MAX(at, excluded.at)", project,
                at.toEpochMilli());
    }

    @Override
    public Optional<Instant> appStart(String project) {
        return jdbc.query("SELECT at FROM app_starts WHERE project = ?", (rs, n) -> Instant.ofEpochMilli(rs.getLong(1)), project).stream().findFirst();
    }
}
