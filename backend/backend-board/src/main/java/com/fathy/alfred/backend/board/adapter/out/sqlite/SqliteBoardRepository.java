package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.SkillRunStorePort;
import com.fathy.alfred.backend.board.domain.model.Advice;
import com.fathy.alfred.backend.board.domain.model.CodeCheck;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
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
import com.fathy.alfred.backend.board.domain.model.Question;
import com.fathy.alfred.backend.board.domain.model.QuestionState;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.Scope;
import com.fathy.alfred.backend.board.domain.model.SimilarClosed;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import com.fathy.alfred.backend.board.domain.model.SpecFileInfo;
import com.fathy.alfred.backend.board.domain.model.Team;
import com.fathy.alfred.backend.board.domain.DefaultTeams;
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
public class SqliteBoardRepository implements BoardStorePort, SkillRunStorePort, com.fathy.alfred.backend.board.application.port.out.BoardImageStorePort {

    private static final Logger log = LoggerFactory.getLogger(SqliteBoardRepository.class);
    private static final int IN_CHUNK = 400;
    /** How many open cards of one signature {@link #openBySignature} keeps: the newest few, enough to find one besides the card asked about. */
    private static final int OPEN_PER_SIGNATURE = 5;
    /** Seatbelt on badge lists: a cycle has hundreds of calls, not hundreds of thousands. */
    private static final int BADGE_ROWS = 20_000;
    private static final TypeReference<List<ChecklistMark.Change>> CHANGES = new TypeReference<>() { };

    static final String SUMMARY_COLUMNS = "id, project, number, kind, title, status, resolution, reason, flags, scope, author, "
            + "cycle_id, cycle_deleted, signature, created_at, updated_at, updated_by, teams, board_id";
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

    /** For SqliteSnippetRepository: the same database, so a card's pages go with it (foreign keys). */
    JdbcTemplate jdbc() {
        return jdbc;
    }

    TransactionTemplate tx() {
        return tx;
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
        // specs/027 boards: a board is the task, a session cycle only stores calls; both relate many-to-many.
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
                  is_default INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'OPEN', migrated_from TEXT,
                  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)
                """);
        jdbc.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_default ON boards(project) WHERE is_default = 1");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_boards_project_state ON boards(project, state)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS board_cycles (board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                  cycle_id TEXT NOT NULL, related_by TEXT NOT NULL, related_at INTEGER NOT NULL, PRIMARY KEY (board_id, cycle_id))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_board_cycles_cycle ON board_cycles(cycle_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS board_boards (a TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                  b TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, PRIMARY KEY (a, b), CHECK (a < b))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_board_boards_b ON board_boards(b)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS card_cycles (card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                  cycle_id TEXT NOT NULL, PRIMARY KEY (card_id, cycle_id))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_card_cycles_cycle ON card_cycles(cycle_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS board_activity (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, actor TEXT NOT NULL, kind TEXT NOT NULL,
                  text TEXT NOT NULL, undo_json TEXT, at INTEGER NOT NULL, undone_at INTEGER)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_board_activity ON board_activity(board_id, id)");
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
        // Rich text (docs/board.md "Rich text"): earlier texts of edited comments and descriptions, and pasted pictures.
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS text_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, text TEXT NOT NULL,
                  actor TEXT NOT NULL, at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_text_versions_owner ON text_versions(owner, id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS board_images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL,
                  card_id TEXT REFERENCES cards(id) ON DELETE CASCADE, cycle_id TEXT, created_at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_board_images_card ON board_images(card_id)");
        // Replies (one level): the comment an entry answers. Added in place to a board.db made before replies existed.
        addColumn("activity", "reply_to", "INTEGER");
        // specs/023: the comment a reply to a reply was written to (reply_to stays the thread's first comment)
        addColumn("activity", "answers", "INTEGER");
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
        // specs/026: is a fix implemented - Claude's looks at the code, the latest per card is the card's
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS code_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                  number INTEGER NOT NULL, verdict TEXT NOT NULL, commit_sha TEXT, branch TEXT, layers_json TEXT, tests TEXT, note TEXT,
                  at INTEGER NOT NULL, actor TEXT NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_code_checks ON code_checks(card_id, id)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS app_starts (project TEXT PRIMARY KEY, at INTEGER NOT NULL)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS app_start_history (project TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (project, at))");
        // specs/018: the requirement check - each Acceptance item's evidence, what each call showed about it, its card
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS item_evidence (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL,
                  project TEXT NOT NULL, endpoint TEXT NOT NULL, evidence_json TEXT NOT NULL, updated_by TEXT NOT NULL,
                  updated_at INTEGER NOT NULL, PRIMARY KEY (cycle_id, file_name, item_key))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_item_evidence_endpoint ON item_evidence(project, endpoint)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS item_call_results (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL,
                  call_id TEXT NOT NULL, result TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL,
                  PRIMARY KEY (cycle_id, file_name, item_key, call_id))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_item_call_results_at ON item_call_results(cycle_id, file_name, item_key, at)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS item_cards (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL,
                  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, PRIMARY KEY (cycle_id, file_name, item_key))
                """);
        // specs/024: comments on a cycle's brief - anchored to a quoted passage or about the whole brief
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS brief_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT NOT NULL, quote TEXT,
                  actor TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER, asks INTEGER NOT NULL DEFAULT 0, suggest_from TEXT,
                  suggest_to TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_brief_comments_cycle ON brief_comments(cycle_id, id)");
        // Teams (Settings -> Teams): a card's teams are a comma list of team ids, like its flags. The default teams are
        // added once - a user who deletes them all does not get them back on the next start.
        addColumn("cards", "teams", "TEXT NOT NULL DEFAULT ''");
        // specs/027: a card's home board. Cards from before it live on their project's default board until the board
        // model migration moves those of a briefed cycle onto that cycle's board.
        addColumn("cards", "board_id", "TEXT");
        jdbc.update("UPDATE cards SET board_id = 'default:' || project WHERE board_id IS NULL");
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id, status)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL,
                  owns TEXT NOT NULL, hints TEXT NOT NULL, position INTEGER NOT NULL)
                """);
        // Skills run from the board with ▶ (docs/board.md "Run from the board"): the queue and each card's run history.
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS skill_runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, cycle_id TEXT, card_number INTEGER,
                  command TEXT NOT NULL, prompt TEXT NOT NULL, note TEXT, model TEXT, host TEXT, state TEXT NOT NULL, outcome TEXT,
                  failure TEXT, retry_at INTEGER, auto_retry INTEGER NOT NULL, result TEXT, steps_json TEXT NOT NULL, stop INTEGER NOT NULL,
                  taken_by TEXT, created_at INTEGER NOT NULL, taken_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL)
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_skill_runs ON skill_runs(project, created_at)");
        addColumn("skill_runs", "chat_id", "TEXT");
        // Claude's questions, one row each (specs/019): the index of the ```questions blocks in question comments.
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS card_questions (entry_id INTEGER NOT NULL, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                  idx INTEGER NOT NULL, header TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, later_until INTEGER, answer_entry INTEGER,
                  parent_idx INTEGER, parent_option TEXT, asked_at INTEGER NOT NULL, PRIMARY KEY (entry_id, idx))
                """);
        jdbc.execute("CREATE INDEX IF NOT EXISTS idx_card_questions ON card_questions(card_id, state)");
        addColumn("card_questions", "recommended", "TEXT");
        // Triage facts that come with the advice (confidence, checked, severity, group), JSON from the ```questions block.
        addColumn("card_questions", "advice_meta", "TEXT");
        // Short names (specs/021): what a mention of a card or an Acceptance item reads, "one-branch search (AC8)".
        jdbc.execute("CREATE TABLE IF NOT EXISTS short_names (kind TEXT NOT NULL, owner TEXT NOT NULL, short TEXT NOT NULL, PRIMARY KEY (kind, owner))");
        jdbc.execute("CREATE TABLE IF NOT EXISTS board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        Integer seeded = jdbc.queryForObject("SELECT COUNT(*) FROM board_meta WHERE key = 'teams_seeded'", Integer.class);
        if (seeded == null || seeded == 0) {
            DefaultTeams.ALL.forEach(this::putTeam);
            jdbc.update("INSERT INTO board_meta(key, value) VALUES ('teams_seeded', '1')");
        }
    }

    // ------------------------------------------------------------------------------------------------- questions (019)

    private static final String QUESTION_COLUMNS = "entry_id, card_id, idx, header, text, state, later_until, answer_entry, parent_idx, parent_option, asked_at, recommended, advice_meta";

    private static final RowMapper<Question> QUESTION_ROW = (rs, n) -> {
        long later = rs.getLong(7);
        Instant laterUntil = rs.wasNull() ? null : Instant.ofEpochMilli(later);
        long answer = rs.getLong(8);
        Long answerEntry = rs.wasNull() ? null : answer;
        int parent = rs.getInt(9);
        Integer parentIdx = rs.wasNull() ? null : parent;
        return new Question(rs.getLong(1), rs.getString(2), rs.getInt(3), rs.getString(4), rs.getString(5), QuestionState.valueOf(rs.getString(6)),
                laterUntil, answerEntry, parentIdx, rs.getString(10), Instant.ofEpochMilli(rs.getLong(11)), rs.getString(12), rs.getString(13));
    };

    @Override
    public void putQuestions(long entryId, List<Question> questions) {
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM card_questions WHERE entry_id = ?", entryId);
            for (Question q : questions) {
                insertQuestion(q);
            }
        });
    }

    private void insertQuestion(Question q) {
        jdbc.update("INSERT INTO card_questions(" + QUESTION_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", q.entryId(), q.cardId(), q.idx(), q.header(),
                q.text(), q.state().name(), q.laterUntil() == null ? null : q.laterUntil().toEpochMilli(), q.answerEntry(), q.parentIdx(),
                q.parentOption(), q.askedAt().toEpochMilli(), q.recommended(), q.adviceMeta());
    }

    @Override
    public List<Question> questionsOf(String cardId) {
        return jdbc.query("SELECT " + QUESTION_COLUMNS + " FROM card_questions WHERE card_id = ? ORDER BY entry_id, idx", QUESTION_ROW, cardId);
    }

    @Override
    public void updateQuestion(Question q) {
        jdbc.update("UPDATE card_questions SET state = ?, later_until = ?, answer_entry = ? WHERE entry_id = ? AND idx = ?", q.state().name(),
                q.laterUntil() == null ? null : q.laterUntil().toEpochMilli(), q.answerEntry(), q.entryId(), q.idx());
    }

    private static final String OPEN_NOW = "(state = 'OPEN' OR (state = 'LATER' AND later_until <= ?))";

    @Override
    public Map<String, Integer> openQuestionCounts(Collection<String> cardIds, Instant now) {
        Map<String, Integer> out = new HashMap<>();
        for (List<String> chunk : chunks(new LinkedHashSet<>(cardIds))) {
            List<Object> args = new ArrayList<>();
            args.add(now.toEpochMilli());
            args.addAll(chunk);
            jdbc.query("SELECT card_id, COUNT(*) FROM card_questions WHERE " + OPEN_NOW + " AND card_id IN (" + marks(chunk.size()) + ") GROUP BY card_id",
                    rs -> { out.put(rs.getString(1), rs.getInt(2)); }, args.toArray());
        }
        return out;
    }

    @Override
    public Map<String, String> shortNames(String kind, Collection<String> owners) {
        Map<String, String> out = new HashMap<>();
        for (List<String> chunk : chunks(new LinkedHashSet<>(owners))) {
            List<Object> args = new ArrayList<>();
            args.add(kind);
            args.addAll(chunk);
            jdbc.query("SELECT owner, short FROM short_names WHERE kind = ? AND owner IN (" + marks(chunk.size()) + ")",
                    rs -> { out.put(rs.getString(1), rs.getString(2)); }, args.toArray());
        }
        return out;
    }

    @Override
    public void putShortName(String kind, String owner, String shortName) {
        if (shortName == null || shortName.isBlank()) {
            jdbc.update("DELETE FROM short_names WHERE kind = ? AND owner = ?", kind, owner);
        } else {
            jdbc.update("INSERT INTO short_names(kind, owner, short) VALUES (?, ?, ?) ON CONFLICT(kind, owner) DO UPDATE SET short = excluded.short",
                    kind, owner, shortName.strip());
        }
    }

    @Override
    public Map<String, String> openQuestionAdvice(Collection<String> cardIds, Instant now) {
        Map<String, String> out = new HashMap<>();
        for (List<String> chunk : chunks(new LinkedHashSet<>(cardIds))) {
            List<Object> args = new ArrayList<>();
            args.add(now.toEpochMilli());
            args.addAll(chunk);
            jdbc.query("SELECT card_id, recommended FROM card_questions WHERE " + OPEN_NOW + " AND recommended IS NOT NULL AND card_id IN ("
                    + marks(chunk.size()) + ") ORDER BY entry_id, idx", rs -> { out.putIfAbsent(rs.getString(1), rs.getString(2)); }, args.toArray());
        }
        return out;
    }

    @Override
    public Map<String, Advice> openQuestionAdviceDetail(Collection<String> cardIds, Instant now) {
        Map<String, Advice> out = new HashMap<>();
        for (List<String> chunk : chunks(new LinkedHashSet<>(cardIds))) {
            List<Object> args = new ArrayList<>();
            args.add(now.toEpochMilli());
            args.addAll(chunk);
            jdbc.query("SELECT card_id, recommended, advice_meta FROM card_questions WHERE " + OPEN_NOW + " AND recommended IS NOT NULL AND card_id IN ("
                    + marks(chunk.size()) + ") ORDER BY entry_id, idx",
                    rs -> { out.putIfAbsent(rs.getString(1), AdviceMeta.read(rs.getString(2), rs.getString(3))); }, args.toArray());
        }
        return out;
    }

    @Override
    public Map<String, Integer> openQuestionCards(String project, String cycleId, Instant now) {
        Map<String, Integer> out = new LinkedHashMap<>();
        List<Object> args = new ArrayList<>(List.of(now.toEpochMilli(), project == null ? "" : project));
        String cycle = "";
        if (cycleId != null && !cycleId.isBlank()) {
            cycle = " AND c.cycle_id = ?";
            args.add(cycleId);
        }
        jdbc.query("SELECT q.card_id, COUNT(*) FROM card_questions q JOIN cards c ON c.id = q.card_id WHERE " + OPEN_NOW.replace("state", "q.state")
                        .replace("later_until", "q.later_until") + " AND c.project = ?" + cycle + " GROUP BY q.card_id ORDER BY MIN(q.asked_at)",
                rs -> { out.put(rs.getString(1), rs.getInt(2)); }, args.toArray());
        return out;
    }

    @Override
    public List<ActivityEntry> unindexedQuestions() {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to, answers FROM activity a WHERE a.actor = 'CLAUDE' "
                + "AND a.kind = 'COMMENT' AND a.text LIKE '**Question**%' AND NOT EXISTS (SELECT 1 FROM card_questions q WHERE q.entry_id = a.id) "
                + "ORDER BY a.id", ACTIVITY_ROW);
    }

    @Override
    public List<ActivityEntry> questionsWithoutAdviceMeta() {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to, answers FROM activity a WHERE EXISTS (SELECT 1 FROM "
                + "card_questions q WHERE q.entry_id = a.id AND q.recommended IS NOT NULL AND q.advice_meta IS NULL) ORDER BY a.id", ACTIVITY_ROW);
    }

    @Override
    public void putAdviceMeta(long entryId, int idx, String meta) {
        jdbc.update("UPDATE card_questions SET advice_meta = ? WHERE entry_id = ? AND idx = ?", meta, entryId, idx);
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
        jdbc.update("INSERT INTO cards(" + DETAIL_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values(c));
    }

    @Override
    public void update(Card c) {
        jdbc.update("""
                UPDATE cards SET project = ?, number = ?, kind = ?, title = ?, status = ?, resolution = ?, reason = ?, flags = ?,
                  scope = ?, author = ?, cycle_id = ?, cycle_deleted = ?, signature = ?, created_at = ?, updated_at = ?,
                  updated_by = ?, teams = ?, board_id = ?, description = ? WHERE id = ?
                """, c.project(), c.number(), c.kind().name(), c.title(), c.status().name(), name(c.resolution()), c.reason(),
                flagsText(c.flags()), c.scope().name(), c.author().name(), c.cycleId(), c.cycleDeleted() ? 1 : 0, c.signature(),
                c.createdAt().toEpochMilli(), c.updatedAt().toEpochMilli(), c.updatedBy().name(), String.join(",", c.teams()),
                c.boardId(), c.description(), c.id());
    }

    private Object[] values(Card c) {
        return new Object[]{c.id(), c.project(), c.number(), c.kind().name(), c.title(), c.status().name(), name(c.resolution()),
                c.reason(), flagsText(c.flags()), c.scope().name(), c.author().name(), c.cycleId(), c.cycleDeleted() ? 1 : 0,
                c.signature(), c.createdAt().toEpochMilli(), c.updatedAt().toEpochMilli(), c.updatedBy().name(),
                String.join(",", c.teams()), c.boardId(), c.description()};
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
        jdbc.update("DELETE FROM short_names WHERE kind = 'card' AND owner = ?", id);
        return jdbc.update("DELETE FROM cards WHERE id = ?", id) > 0;
    }

    @Override
    public List<String> cardIdsOfCycle(String cycleId) {
        return jdbc.queryForList("SELECT id FROM cards WHERE cycle_id = ? LIMIT 10000", String.class, cycleId);
    }

    @Override
    public com.fathy.alfred.backend.board.domain.model.BoardStorage storage() {
        long pageSize = longOf("PRAGMA page_size");
        long pages = longOf("PRAGMA page_count");
        long free = longOf("PRAGMA freelist_count");
        long file = 0;
        for (String suffix : new String[] {"", "-wal", "-shm"}) {
            try {
                file += Files.size(Path.of(dbFile + suffix));
            } catch (IOException e) {
                // no WAL or shared-memory file yet
            }
        }
        return new com.fathy.alfred.backend.board.domain.model.BoardStorage(file, (pages - free) * pageSize, free * pageSize,
                longOf("SELECT COUNT(*) FROM cards"), longOf("SELECT COUNT(*) FROM activity WHERE kind = 'COMMENT'"),
                longOf("SELECT COUNT(*) FROM spec_files"), longOf("SELECT COUNT(*) FROM cycle_briefs"),
                longOf("SELECT COUNT(*) FROM cards WHERE cycle_deleted = 1"));
    }

    private long longOf(String sql) {
        Long n = jdbc.queryForObject(sql, Long.class);
        return n == null ? 0 : n;
    }

    @Override
    public synchronized void compact() {
        // The WAL is folded back first, then VACUUM rewrites the file without its free pages.
        jdbc.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        jdbc.execute("VACUUM");
        jdbc.execute("PRAGMA wal_checkpoint(TRUNCATE)");
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
        if (q.boardId() != null) {
            // specs/027 FR-011: the board's own cards, and unless "own only" the cards of its related cycles and boards
            if (q.withRelated()) {
                parts.add("(board_id = ? OR cycle_id IN (SELECT cycle_id FROM board_cycles WHERE board_id = ?)"
                        + " OR id IN (SELECT cc.card_id FROM card_cycles cc JOIN board_cycles bc ON bc.cycle_id = cc.cycle_id WHERE bc.board_id = ?)"
                        + " OR board_id IN (SELECT b FROM board_boards WHERE a = ? UNION SELECT a FROM board_boards WHERE b = ?))");
                for (int i = 0; i < 5; i++) {
                    args.add(q.boardId());
                }
            } else {
                parts.add("board_id = ?");
                args.add(q.boardId());
            }
        } else if (q.cycleId() != null) {
            // a cycle's cards: found in it, or related to it since (specs/027 card_cycles)
            parts.add("(cycle_id = ? OR id IN (SELECT card_id FROM card_cycles WHERE cycle_id = ?))");
            args.add(q.cycleId());
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
        if (q.cycleDeleted()) {
            parts.add("cycle_deleted = 1");
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
        if (!q.teams().isEmpty()) {
            // any of the asked teams; NO_TEAM asks for cards with none
            List<String> any = new ArrayList<>();
            for (String team : q.teams()) {
                if (CardQuery.NO_TEAM.equals(team)) {
                    any.add("teams = ''");
                } else {
                    any.add("(',' || teams || ',') LIKE ?");
                    args.add("%," + team + ",%");
                }
            }
            parts.add("(" + String.join(" OR ", any) + ")");
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
        return progressWhere(cycleId != null ? "cycle_id = ?" : "project = ?", cycleId != null ? cycleId : (project == null ? "" : project));
    }

    @Override
    public CardsPage.Progress boardProgress(String boardId) {
        return progressWhere("board_id = ?", boardId);
    }

    private CardsPage.Progress progressWhere(String where, Object arg) {
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
            jdbc.update("INSERT INTO activity(card_id, actor, kind, text, old_value, new_value, at, reply_to, answers) VALUES (?,?,?,?,?,?,?,?,?)",
                    e.cardId(), e.actor().name(), e.kind().name(), e.text(), e.oldValue(), e.newValue(), e.at().toEpochMilli(), e.replyTo(),
                    e.answers());
            Long id = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            return id == null ? 0L : id;
        });
    }

    @Override
    public List<ActivityEntry> activity(String cardId, int offset, int limit) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to, answers FROM activity WHERE card_id = ? "
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
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to, answers FROM activity WHERE card_id = ? AND kind = ? "
                + "ORDER BY id DESC LIMIT 1", ACTIVITY_ROW, cardId, kind).stream().findFirst();
    }

    @Override
    public Optional<ActivityEntry> activityEntry(long id) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to, answers FROM activity WHERE id = ?", ACTIVITY_ROW, id)
                .stream().findFirst();
    }

    @Override
    public void updateActivityText(long id, String text) {
        jdbc.update("UPDATE activity SET text = ? WHERE id = ?", text, id);
    }

    @Override
    public void deleteActivity(long id) {
        jdbc.update("DELETE FROM activity WHERE id = ?", id);
    }

    @Override
    public void saveVersion(com.fathy.alfred.backend.board.domain.model.TextVersion v) {
        jdbc.update("INSERT INTO text_versions(owner, text, actor, at) VALUES (?,?,?,?)", v.owner(), v.text(), v.actor().name(), v.at().toEpochMilli());
    }

    @Override
    public List<com.fathy.alfred.backend.board.domain.model.TextVersion> versions(String owner) {
        return jdbc.query("SELECT owner, text, actor, at FROM text_versions WHERE owner = ? ORDER BY id DESC LIMIT 100",
                (rs, n) -> new com.fathy.alfred.backend.board.domain.model.TextVersion(rs.getString(1), rs.getString(2), Actor.valueOf(rs.getString(3)),
                        Instant.ofEpochMilli(rs.getLong(4))), owner);
    }

    // --------------------------------------------------------------------------------------------------------------- images

    @Override
    public void saveImage(com.fathy.alfred.backend.board.domain.model.BoardImage i) {
        jdbc.update("INSERT INTO board_images(id, mime, data, size, card_id, cycle_id, created_at) VALUES (?,?,?,?,?,?,?)", i.id(), i.mime(),
                i.data(), i.data().length, i.cardId(), i.cycleId(), i.createdAt().toEpochMilli());
    }

    @Override
    public Optional<com.fathy.alfred.backend.board.domain.model.BoardImage> findImage(String id) {
        return jdbc.query("SELECT id, mime, data, card_id, cycle_id, created_at FROM board_images WHERE id = ?",
                (rs, n) -> new com.fathy.alfred.backend.board.domain.model.BoardImage(rs.getString(1), rs.getString(2), rs.getBytes(3),
                        rs.getString(4), rs.getString(5), Instant.ofEpochMilli(rs.getLong(6))), id).stream().findFirst();
    }

    @Override
    public void attachImages(Collection<String> ids, String cardId, String cycleId) {
        for (String id : ids) {
            jdbc.update("UPDATE board_images SET card_id = ?, cycle_id = ? WHERE id = ? AND card_id IS NULL AND cycle_id IS NULL", cardId, cycleId, id);
        }
    }

    @Override
    public int deleteUnattachedImages(Instant before) {
        return jdbc.update("DELETE FROM board_images WHERE card_id IS NULL AND cycle_id IS NULL AND created_at < ?", before.toEpochMilli());
    }

    @Override
    public List<ActivityEntry> after(String cardId, long afterId) {
        return jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to, answers FROM activity WHERE card_id = ? AND id > ? "
                + "ORDER BY id LIMIT 1000", ACTIVITY_ROW, cardId, afterId);
    }

    @Override
    public Map<String, ActivityEntry> lastComments(Collection<String> cardIds) {
        Map<String, ActivityEntry> out = new HashMap<>();
        for (List<String> chunk : chunks(cardIds)) {
            jdbc.query("SELECT id, card_id, actor, kind, text, old_value, new_value, at, reply_to, answers FROM activity WHERE id IN (SELECT MAX(id) FROM activity "
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
                + "c.project, c.number, c.title, c.status, c.cycle_id, a.answers FROM activity a JOIN cards c ON c.id = a.card_id WHERE a.id > ?");
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
    public long activityIdBefore(Instant at) {
        Long n = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM activity WHERE at < ?", Long.class, at.toEpochMilli());
        return n == null ? 0 : n;
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
        // a captured call keeps its live call's id: a mentioned copy keeps the live call (its statements, Redis, log lines) too (specs/027 R7)
        return new LinkedHashSet<>(jdbc.queryForList("SELECT DISTINCT call_id FROM mentions WHERE call_id IS NOT NULL", String.class));
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
            jdbc.query("SELECT signature, number, title, resolution, reason, kind FROM cards WHERE project = ? AND status = 'CLOSED' "
                    + "AND signature IN (" + marks(chunk.size()) + ") ORDER BY updated_at DESC", rs -> {
                        out.putIfAbsent(rs.getString(1), new SimilarClosed(rs.getInt(2), rs.getString(3), resolution(rs.getString(4)),
                                rs.getString(5), rs.getString(6) == null ? null : CardKind.valueOf(rs.getString(6))));
                    }, args.toArray());
        }
        return out;
    }

    @Override
    public Map<String, List<Card>> openBySignature(String project, Collection<String> signatures) {
        Map<String, List<Card>> out = new HashMap<>();
        for (List<String> chunk : chunks(new LinkedHashSet<>(signatures))) {
            List<Object> args = new ArrayList<>();
            args.add(project == null ? "" : project);
            args.addAll(chunk);
            // idx_cards_signature narrows to the cards of these signatures; the project and status filters run on that handful.
            jdbc.query("SELECT " + SUMMARY_COLUMNS + " FROM cards WHERE project = ? AND status != 'CLOSED' AND signature IN ("
                    + marks(chunk.size()) + ") ORDER BY updated_at DESC, number DESC", rs -> {
                        List<Card> same = out.computeIfAbsent(rs.getString("signature"), k -> new ArrayList<>());
                        if (same.size() < OPEN_PER_SIGNATURE) {
                            same.add(SUMMARY_ROW.mapRow(rs, 0));
                        }
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
            jdbc.update("DELETE FROM brief_comments WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM spec_files WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM checklist_marks WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM checklist_suggestions WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM short_names WHERE kind = 'item' AND owner LIKE ? ESCAPE '\\'", like);
            jdbc.update("DELETE FROM cycle_log WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM cycle_steps WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM card_spec_items WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM item_evidence WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM item_call_results WHERE cycle_id = ?", cycleId);
            jdbc.update("DELETE FROM item_cards WHERE cycle_id = ?", cycleId);
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
                Actor.valueOf(rs.getString("updated_by")), teamsOf(rs.getString("teams")), rs.getString("board_id"));
    }

    private static List<String> teamsOf(String s) {
        return s == null || s.isBlank() ? List.of() : Arrays.stream(s.split(",")).map(String::strip).filter(x -> !x.isEmpty()).toList();
    }

    // ------------------------------------------------------------------------------------------------------- teams

    @Override
    public List<Team> teams() {
        return jdbc.query("SELECT id, name, color, icon, owns, hints, position FROM teams ORDER BY position, name LIMIT 500",
                (rs, n) -> new Team(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5),
                        hintsOf(rs.getString(6)), rs.getInt(7)));
    }

    @Override
    public void putTeam(Team t) {
        jdbc.update("""
                INSERT INTO teams(id, name, color, icon, owns, hints, position) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, icon = excluded.icon, owns = excluded.owns,
                  hints = excluded.hints, position = excluded.position
                """, t.id(), t.name(), t.color(), t.icon(), t.owns(), hintsText(t.hints()), t.position());
    }

    @Override
    public void deleteTeam(String id) {
        tx.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM teams WHERE id = ?", id);
            jdbc.update("UPDATE cards SET teams = TRIM(REPLACE(',' || teams || ',', ',' || ? || ',', ','), ',') "
                    + "WHERE (',' || teams || ',') LIKE ?", id, "%," + id + ",%");
        });
    }

    private String hintsText(List<String> hints) {
        try {
            return objectMapper.writeValueAsString(hints);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private List<String> hintsOf(String text) {
        try {
            return text == null || text.isBlank() ? List.of() : objectMapper.readValue(text, new TypeReference<List<String>>() { });
        } catch (JsonProcessingException e) {
            return List.of();
        }
    }

    private static final RowMapper<ActivityEntry> ACTIVITY_ROW = (rs, n) -> new ActivityEntry(rs.getLong(1), rs.getString(2),
            Actor.valueOf(rs.getString(3)), ActivityKind.valueOf(rs.getString(4)), rs.getString(5), rs.getString(6), rs.getString(7),
            Instant.ofEpochMilli(rs.getLong(8)), replyTo(rs), answers(rs));

    private static Long replyTo(ResultSet rs) throws SQLException {
        long v = rs.getLong(9);
        return rs.wasNull() ? null : v;
    }

    /** By name: every activity query selects it, though not always as its 10th column. */
    private static Long answers(ResultSet rs) throws SQLException {
        long v = rs.getLong("answers");
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
    public void putCodeCheck(CodeCheck c) {
        tx.executeWithoutResult(status -> {
            jdbc.update("INSERT INTO code_checks(card_id, number, verdict, commit_sha, branch, layers_json, tests, note, at, actor) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    c.cardId(), c.number(), c.verdict(), c.commit(), c.branch(), CodeChecks.layersJson(c.layers()), c.tests(), c.note(),
                    c.at().toEpochMilli(), c.by().name());
            // keep the last 20 looks per card
            jdbc.update("DELETE FROM code_checks WHERE card_id = ? AND id NOT IN (SELECT id FROM code_checks WHERE card_id = ? ORDER BY id DESC LIMIT 20)",
                    c.cardId(), c.cardId());
        });
    }

    @Override
    public Optional<CodeCheck> codeCheck(String cardId) {
        return jdbc.query("SELECT card_id, number, verdict, commit_sha, branch, layers_json, tests, note, at, actor FROM code_checks WHERE card_id = ? "
                + "ORDER BY id DESC LIMIT 1", (rs, n) -> new CodeCheck(rs.getString(1), rs.getInt(2), rs.getString(3), rs.getString(4), rs.getString(5),
                CodeChecks.layers(rs.getString(6)), rs.getString(7), rs.getString(8), Instant.ofEpochMilli(rs.getLong(9)),
                CodeChecks.actor(rs.getString(10))), cardId).stream().findFirst();
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
        jdbc.update("INSERT OR IGNORE INTO app_start_history(project, at) VALUES (?,?)", project, at.toEpochMilli());
        jdbc.update("DELETE FROM app_start_history WHERE project = ? AND at NOT IN (SELECT at FROM app_start_history WHERE project = ? ORDER BY at DESC LIMIT "
                + APP_STARTS_KEPT + ")", project, project);
    }

    /** App starts kept per project: enough to tell the build of any call a re-test still reads. */
    static final int APP_STARTS_KEPT = 50;

    @Override
    public List<Instant> appStarts(String project) {
        List<Instant> out = new ArrayList<>(jdbc.query("SELECT at FROM app_start_history WHERE project = ? ORDER BY at",
                (rs, n) -> Instant.ofEpochMilli(rs.getLong(1)), project));
        // a start recorded before the history existed
        appStart(project).filter(a -> !out.contains(a)).ifPresent(a -> { out.add(a); out.sort(null); });
        return out;
    }

    @Override
    public Optional<Instant> appStart(String project) {
        return jdbc.query("SELECT at FROM app_starts WHERE project = ?", (rs, n) -> Instant.ofEpochMilli(rs.getLong(1)), project).stream().findFirst();
    }

    // ------------------------------------------------------------------------------------------------------ skill runs

    private static final String RUN_COLUMNS = "id, project, cycle_id, card_number, command, prompt, note, model, host, state, outcome, failure, "
            + "retry_at, auto_retry, result, steps_json, stop, taken_by, created_at, taken_at, ended_at, updated_at, chat_id";

    @Override
    public void saveRun(SkillRun r) {
        jdbc.update("INSERT OR REPLACE INTO skill_runs(" + RUN_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                r.id(), r.project(), r.cycleId(), r.cardNumber(), r.command(), r.prompt(), r.note(), r.model(), r.host(), r.state().name(),
                r.outcome(), r.failure(), millis(r.retryAt()), r.autoRetry() ? 1 : 0, r.result(), json(r.steps()), r.stop() ? 1 : 0, r.takenBy(),
                r.createdAt().toEpochMilli(), millis(r.takenAt()), millis(r.endedAt()), r.updatedAt().toEpochMilli(), r.chatId());
    }

    @Override
    public Optional<SkillRun> findRun(String id) {
        return jdbc.query("SELECT " + RUN_COLUMNS + " FROM skill_runs WHERE id = ?", this::run, id).stream().findFirst();
    }

    @Override
    public List<SkillRun> runs(String project, Integer cardNumber, int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + RUN_COLUMNS + " FROM skill_runs WHERE 1=1");
        List<Object> args = new ArrayList<>();
        if (project != null) {
            sql.append(" AND project = ?");
            args.add(project);
        }
        if (cardNumber != null) {
            sql.append(" AND card_number = ?");
            args.add(cardNumber);
        }
        sql.append(" ORDER BY created_at DESC, id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), this::run, args.toArray());
    }

    @Override
    public List<SkillRun> activeRuns(String project) {
        return project == null
                ? jdbc.query("SELECT " + RUN_COLUMNS + " FROM skill_runs WHERE state IN ('QUEUED','SENT','RUNNING') ORDER BY created_at, id", this::run)
                : jdbc.query("SELECT " + RUN_COLUMNS + " FROM skill_runs WHERE project = ? AND state IN ('QUEUED','SENT','RUNNING') ORDER BY created_at, id",
                this::run, project);
    }

    @Override
    public void pruneRuns(String project, int keep) {
        jdbc.update("DELETE FROM skill_runs WHERE project = ? AND state NOT IN ('QUEUED','SENT','RUNNING') AND id NOT IN "
                + "(SELECT id FROM skill_runs WHERE project = ? ORDER BY created_at DESC LIMIT ?)", project, project, keep);
    }

    private SkillRun run(ResultSet rs, int n) throws SQLException {
        List<String> steps;
        try {
            steps = objectMapper.readValue(rs.getString("steps_json"), new TypeReference<List<String>>() { });
        } catch (JsonProcessingException e) {
            steps = List.of();
        }
        int card = rs.getInt("card_number");
        Integer cardNumber = rs.wasNull() ? null : card;
        return new SkillRun(rs.getString("id"), rs.getString("project"), rs.getString("cycle_id"), cardNumber, rs.getString("command"),
                rs.getString("prompt"), rs.getString("note"), rs.getString("model"), rs.getString("host"), SkillRun.State.valueOf(rs.getString("state")),
                rs.getString("outcome"), rs.getString("failure"), instant(rs, "retry_at"), rs.getInt("auto_retry") == 1, rs.getString("result"), steps,
                rs.getInt("stop") == 1, rs.getString("taken_by"), Instant.ofEpochMilli(rs.getLong("created_at")), instant(rs, "taken_at"),
                instant(rs, "ended_at"), Instant.ofEpochMilli(rs.getLong("updated_at")), rs.getString("chat_id"));
    }

    private static Long millis(Instant at) {
        return at == null ? null : at.toEpochMilli();
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        long v = rs.getLong(column);
        return rs.wasNull() ? null : Instant.ofEpochMilli(v);
    }

    private String json(List<String> steps) {
        try {
            return objectMapper.writeValueAsString(steps);
        } catch (JsonProcessingException e) {
            return "[]";
        }
    }
}
