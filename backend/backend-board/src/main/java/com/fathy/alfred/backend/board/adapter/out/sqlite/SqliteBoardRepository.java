package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CallBadge;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CardsPage;
import com.fathy.alfred.backend.board.domain.model.ChecklistMark;
import com.fathy.alfred.backend.board.domain.model.ClosedReason;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.Mark;
import com.fathy.alfred.backend.board.domain.model.Mention;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
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
        } else {
            parts.add("project = ?");
            args.add(q.project() == null ? "" : q.project());
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
        return " WHERE " + String.join(" AND ", parts);
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
            jdbc.update("INSERT INTO activity(card_id, actor, kind, text, old_value, new_value, at) VALUES (?,?,?,?,?,?,?)",
                    e.cardId(), e.actor().name(), e.kind().name(), e.text(), e.oldValue(), e.newValue(), e.at().toEpochMilli());
            Long id = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            return id == null ? 0L : id;
        });
    }

    @Override
    public List<ActivityEntry> activity(String cardId, int offset, int limit) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at FROM activity WHERE card_id = ? "
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
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at FROM activity WHERE card_id = ? AND kind = ? "
                + "ORDER BY id DESC LIMIT 1", ACTIVITY_ROW, cardId, kind).stream().findFirst();
    }

    @Override
    public List<ActivityEntry> after(String cardId, long afterId) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at FROM activity WHERE card_id = ? AND id > ? "
                + "ORDER BY id LIMIT 1000", ACTIVITY_ROW, cardId, afterId);
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
        return badges("SELECT DISTINCT m.call_id, c.project, c.number, c.kind, c.status, c.resolution FROM mentions m "
                + "JOIN cards c ON c.id = m.card_id WHERE m.call_id IS NOT NULL AND (m.cycle_id = ? OR c.cycle_id = ?) "
                + "ORDER BY c.number LIMIT " + BADGE_ROWS, cycleId, cycleId);
    }

    @Override
    public Map<String, List<CallBadge>> badgesOfCalls(Collection<String> callIds) {
        Map<String, List<CallBadge>> out = new LinkedHashMap<>();
        for (List<String> chunk : chunks(callIds)) {
            out.putAll(badges("SELECT DISTINCT m.call_id, c.project, c.number, c.kind, c.status, c.resolution FROM mentions m "
                    + "JOIN cards c ON c.id = m.card_id WHERE m.call_id IN (" + marks(chunk.size()) + ") ORDER BY c.number LIMIT "
                    + BADGE_ROWS, chunk.toArray()));
        }
        return out;
    }

    private Map<String, List<CallBadge>> badges(String sql, Object... args) {
        Map<String, List<CallBadge>> out = new LinkedHashMap<>();
        jdbc.query(sql, rs -> {
            out.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(new CallBadge(rs.getString(2), rs.getInt(3),
                    CardKind.valueOf(rs.getString(4)), CardStatus.valueOf(rs.getString(5)), resolution(rs.getString(6))));
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

    // ---------------------------------------------------------------------------------------- brief, spec files, checklist

    @Override
    public Optional<CycleBrief> brief(String cycleId) {
        return jdbc.query("SELECT cycle_id, text, updated_at FROM cycle_briefs WHERE cycle_id = ?",
                (rs, n) -> new CycleBrief(rs.getString(1), rs.getString(2), Instant.ofEpochMilli(rs.getLong(3))), cycleId).stream().findFirst();
    }

    @Override
    public void putBrief(CycleBrief b) {
        jdbc.update("INSERT INTO cycle_briefs(cycle_id, text, updated_at) VALUES (?,?,?) "
                + "ON CONFLICT(cycle_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
                b.cycleId(), b.text(), b.updatedAt().toEpochMilli());
    }

    @Override
    public List<SpecFileInfo> specs(String cycleId) {
        return jdbc.query("SELECT name, size, uploaded_at FROM spec_files WHERE cycle_id = ? ORDER BY name LIMIT 1000",
                (rs, n) -> new SpecFileInfo(rs.getString(1), rs.getLong(2), Instant.ofEpochMilli(rs.getLong(3))), cycleId);
    }

    @Override
    public Optional<SpecFile> spec(String cycleId, String name) {
        return jdbc.query("SELECT cycle_id, name, content, size, uploaded_at FROM spec_files WHERE cycle_id = ? AND name = ?",
                (rs, n) -> new SpecFile(rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4),
                        Instant.ofEpochMilli(rs.getLong(5))), cycleId, name).stream().findFirst();
    }

    @Override
    public boolean putSpec(SpecFile f) {
        Boolean replaced = tx.execute(status -> {
            Integer existing = jdbc.queryForObject("SELECT COUNT(*) FROM spec_files WHERE cycle_id = ? AND name = ?", Integer.class,
                    f.cycleId(), f.name());
            jdbc.update("INSERT INTO spec_files(cycle_id, name, content, size, uploaded_at) VALUES (?,?,?,?,?) "
                    + "ON CONFLICT(cycle_id, name) DO UPDATE SET content = excluded.content, size = excluded.size, "
                    + "uploaded_at = excluded.uploaded_at", f.cycleId(), f.name(), f.content(), f.size(), f.uploadedAt().toEpochMilli());
            return existing != null && existing > 0;
        });
        return Boolean.TRUE.equals(replaced);
    }

    @Override
    public boolean deleteSpec(String cycleId, String name) {
        return jdbc.update("DELETE FROM spec_files WHERE cycle_id = ? AND name = ?", cycleId, name) > 0;
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

    @Override
    public void cycleRemoved(String cycleId) {
        String like = cycleId.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%";
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM cycle_briefs WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM spec_files WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM checklist_marks WHERE cycle_id = ?", cycleId);
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
            Instant.ofEpochMilli(rs.getLong(8)));

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
}
