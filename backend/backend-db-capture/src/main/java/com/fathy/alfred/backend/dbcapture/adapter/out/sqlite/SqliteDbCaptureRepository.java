package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.domain.StatementFlags;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.BeforeImage;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.domain.model.CallOnThread;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.Column;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlag;
import com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOrigin;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementTransaction;
import com.fathy.alfred.backend.dbcapture.domain.model.TableIndex;
import com.fathy.alfred.backend.dbcapture.domain.model.TraceHit;
import com.fathy.alfred.backend.dbcapture.domain.model.TxLifecycle;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * db-capture.db - its own SQLite file (named volume, like logs.db) so capture volume never slows alfred.db.
 *
 * <p>Statement summary columns and their JSON (params, outcome, before-image) live in {@code statements}; rows live
 * in {@code result_rows}, keyed by (statement, part, index), so a 50,000-row result is paged 100 at a time and never
 * read whole. List reads name their columns and never touch {@code result_rows}; every read has a LIMIT.
 *
 * <p>Ingest is idempotent on the agent's own statement id ({@code agent_sid}): a batch the agent retried after a
 * timeout stores nothing twice, and the continuation chunks of a long result append to the statement with the same
 * sid. No flat-file alternative exists, for the same reason backend-logs has none: paged rows and per-call indexes
 * over millions of rows have no file equivalent (plan Complexity Tracking).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.db-capture", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteDbCaptureRepository implements DbCaptureStorePort {

    private static final Logger log = LoggerFactory.getLogger(SqliteDbCaptureRepository.class);

    static final String RESULT = "RESULT";
    static final String BEFORE_IMAGE = "BEFORE_IMAGE";
    private static final int IN_CHUNK = 400;

    private static final TypeReference<List<List<TypedValue>>> VALUE_ROWS = new TypeReference<>() { };
    private static final TypeReference<List<TypedValue>> VALUE_ROW = new TypeReference<>() { };
    private static final TypeReference<List<String>> STRINGS = new TypeReference<>() { };
    private static final TypeReference<List<DbFlag>> FLAGS = new TypeReference<>() { };
    private static final TypeReference<List<TableIndex>> INDEXES = new TypeReference<>() { };

    private static final String STATEMENT_COLUMNS = "id, call_id, thread_name, seq, kind, sql, fingerprint, table_name, params_json, "
            + "outcome_json, started_at, duration_us, offset_us, tx_id, connection_id, code_location, run_tag, data_source, "
            + "before_json, cascades_json, undone, expected, stored_rows, origin_json, callers_json, indexes_json";

    private final ObjectMapper objectMapper;

    @Value("${DB_CAPTURE_DB_FILE:/appdata/db-capture.db}")
    private String dbFile;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbcTemplate;
    private TransactionTemplate transactions;

    public SqliteDbCaptureRepository(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    void init() {
        Path path = Path.of(dbFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Could not create directory for " + dbFile, e);
        }
        HikariConfig config = new HikariConfig();
        // IMMEDIATE: ingest reads (does this sid exist?) then writes. Every pragma goes in the URL, never a compound
        // connectionInitSql - the driver runs only the FIRST statement of that string, which left busy_timeout at its
        // 3 s default and made concurrent agent batches fail with SQLITE_BUSY (DbCaptureThroughputTest; the same trap
        // SqliteCallsRepository documents).
        config.setJdbcUrl("jdbc:sqlite:" + path + "?transaction_mode=IMMEDIATE&journal_mode=WAL&synchronous=NORMAL&busy_timeout=30000"
                + "&cache_size=-8192&temp_store=MEMORY");
        config.setMaximumPoolSize(4);
        config.setPoolName("db-capture-sqlite-pool");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        createSchema();
        if (!Files.isWritable(path)) {
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
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS statements (
                  id INTEGER PRIMARY KEY,
                  agent_sid TEXT NOT NULL UNIQUE,
                  call_id TEXT, thread_name TEXT NOT NULL, seq INTEGER NOT NULL,
                  kind TEXT NOT NULL, sql TEXT NOT NULL, fingerprint TEXT, table_name TEXT,
                  params_json TEXT NOT NULL, outcome_json TEXT NOT NULL,
                  started_at TEXT NOT NULL, duration_us INTEGER NOT NULL, offset_us INTEGER NOT NULL,
                  tx_id TEXT, connection_id TEXT, code_location TEXT, run_tag TEXT, data_source TEXT,
                  before_json TEXT, cascades_json TEXT,
                  undone INTEGER NOT NULL DEFAULT 0, expected INTEGER NOT NULL DEFAULT 0,
                  stored_rows INTEGER NOT NULL DEFAULT 0,
                  approx_bytes INTEGER NOT NULL
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_statements_call_seq ON statements(call_id, seq) WHERE call_id IS NOT NULL");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_statements_outside ON statements(thread_name, started_at) WHERE call_id IS NULL");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_statements_started ON statements(started_at)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_statements_run ON statements(run_tag) WHERE run_tag IS NOT NULL");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS result_rows (
                  statement_id INTEGER NOT NULL, part TEXT NOT NULL, row_index INTEGER NOT NULL, values_json TEXT NOT NULL,
                  PRIMARY KEY (statement_id, part, row_index)
                ) WITHOUT ROWID
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS transactions (
                  call_id TEXT NOT NULL, tx_id TEXT NOT NULL, connection_id TEXT,
                  first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, outcome TEXT NOT NULL, held_us INTEGER NOT NULL,
                  statement_count INTEGER NOT NULL, write_count INTEGER NOT NULL,
                  PRIMARY KEY (call_id, tx_id)
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS call_markers (
                  call_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, method TEXT, url TEXT,
                  PRIMARY KEY (call_id, seq)
                ) WITHOUT ROWID
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS call_db_summary (
                  call_id TEXT PRIMARY KEY, statement_count INTEGER NOT NULL, write_count INTEGER NOT NULL,
                  delete_count INTEGER NOT NULL, failed_count INTEGER NOT NULL, tx_count INTEGER NOT NULL,
                  rolled_back_count INTEGER NOT NULL, db_us INTEGER NOT NULL, dropped_count INTEGER NOT NULL DEFAULT 0,
                  flags_json TEXT NOT NULL DEFAULT '[]', last_seq INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
                  ended_early INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, project TEXT
                )
                """);
        addColumnIfMissing("call_db_summary", "project", "TEXT");
        // The request thread on the CALL_OPEN row: log lines are matched to a call by it (specs/008-logs-call-link).
        addColumnIfMissing("call_markers", "thread", "TEXT");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_markers_open_thread ON call_markers(thread, at) WHERE seq = 0");
        addColumnIfMissing("call_db_summary", "flags_version", "INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing("statements", "origin_json", "TEXT");
        addColumnIfMissing("statements", "callers_json", "TEXT");
        addColumnIfMissing("statements", "indexes_json", "TEXT");
        addColumnIfMissing("transactions", "lifecycle_json", "TEXT");
        // Failed statements are a column with their own partial index, so a call's failures (and "which of these calls
        // had one") are one indexed read instead of a json_extract over every statement the call ran.
        if (addColumnIfMissing("statements", "failed", "INTEGER NOT NULL DEFAULT 0")) {
            int filled = jdbcTemplate.update("UPDATE statements SET failed = 1 WHERE failed = 0 AND json_extract(outcome_json, '$.kind') = 'FAILED'");
            log.info("db-capture: marked {} stored statements as failed (one-time fill of the new column)", filled);
        }
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_statements_failed ON statements(call_id, seq) WHERE failed = 1");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_summary_first_seen ON call_db_summary(first_seen)");
        // Log lines the agent caught (specs/009-agent-log-capture): next to the call's statements, evicted with them.
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS call_log_lines (
                  id INTEGER PRIMARY KEY, call_id TEXT, seq INTEGER NOT NULL, at TEXT NOT NULL, at_ms INTEGER NOT NULL,
                  level TEXT, logger TEXT, thread TEXT, message TEXT, exception_json TEXT, cut INTEGER NOT NULL DEFAULT 0,
                  project TEXT, approx_bytes INTEGER NOT NULL
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_log_lines_call ON call_log_lines(call_id, seq) WHERE call_id IS NOT NULL");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_log_lines_outside ON call_log_lines(project, thread, at_ms) WHERE call_id IS NULL");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS call_log_summary (
                  call_id TEXT PRIMARY KEY, lines INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
                  warnings INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0
                )
                """);
        addColumnIfMissing("call_markers", "logs", "INTEGER");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS capture_settings (project TEXT PRIMARY KEY, settings_json TEXT NOT NULL)");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, project TEXT NOT NULL, status_json TEXT NOT NULL, last_seen TEXT NOT NULL)");
    }

    // ------------------------------------------------------------------ ingest

    @Override
    public int saveStatements(List<IncomingStatement> statements) {
        Integer saved = transactions.execute(status -> {
            int fresh = 0;
            for (IncomingStatement s : statements) {
                List<Long> existing = jdbcTemplate.queryForList("SELECT id FROM statements WHERE agent_sid = ?", Long.class, s.sid());
                if (existing.isEmpty()) {
                    insertStatement(s);
                    fresh++;
                } else if (s.rowsFrom() > 0) {
                    appendRows(existing.get(0), s);
                }
            }
            return fresh;
        });
        return saved == null ? 0 : saved;
    }

    private void insertStatement(IncomingStatement s) {
        String params = json(s.params() == null ? List.of() : s.params());
        String outcome = json(s.outcome());
        String before = s.beforeImage() == null ? null : json(s.beforeImage());
        String cascades = s.cascadesTo() == null || s.cascadesTo().isEmpty() ? null : json(s.cascadesTo());
        String origin = s.origin() == null ? null : json(s.origin());
        String callers = s.callers() == null || s.callers().isEmpty() ? null : json(s.callers());
        String indexes = s.indexes() == null || s.indexes().isEmpty() ? null : json(s.indexes());
        long rowsBytes = 0;
        long id = insertReturningId(s, params, outcome, before, cascades, origin, callers, indexes);
        rowsBytes += insertRows(id, RESULT, s.rowsFrom(), s.rows());
        rowsBytes += insertRows(id, BEFORE_IMAGE, 0, s.beforeImageRows());
        long stored = s.rows() == null ? 0 : s.rows().size();
        long bytes = s.sql().length() + params.length() + outcome.length() + (before == null ? 0 : before.length())
                + (origin == null ? 0 : origin.length()) + (callers == null ? 0 : callers.length()) + rowsBytes;
        jdbcTemplate.update("UPDATE statements SET stored_rows = ?, approx_bytes = ? WHERE id = ?", stored, bytes, id);
    }

    private long insertReturningId(IncomingStatement s, String params, String outcome, String before, String cascades, String origin,
                                   String callers, String indexes) {
        Long id = jdbcTemplate.execute((ConnectionCallback<Long>) connection -> {
            try (PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO statements (agent_sid, call_id, thread_name, seq, kind, sql, fingerprint, table_name, params_json,
                      outcome_json, started_at, duration_us, offset_us, tx_id, connection_id, code_location, run_tag, data_source,
                      before_json, cascades_json, origin_json, callers_json, indexes_json, failed, approx_bytes)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
                    """, Statement.RETURN_GENERATED_KEYS)) {
                ps.setString(1, s.sid());
                ps.setString(2, s.callId());
                ps.setString(3, s.thread());
                ps.setInt(4, s.seq());
                ps.setString(5, s.kind().name());
                ps.setString(6, s.sql());
                ps.setString(7, s.fingerprint());
                ps.setString(8, s.table());
                ps.setString(9, params);
                ps.setString(10, outcome);
                ps.setString(11, s.startedAt() == null ? Instant.now().toString() : s.startedAt());
                ps.setLong(12, s.durationMicros());
                ps.setLong(13, s.offsetMicros());
                ps.setString(14, s.txId());
                ps.setString(15, s.connectionId());
                ps.setString(16, s.codeLocation());
                ps.setString(17, s.runTag());
                ps.setString(18, s.dataSource());
                ps.setString(19, before);
                ps.setString(20, cascades);
                ps.setString(21, origin);
                ps.setString(22, callers);
                ps.setString(23, indexes);
                ps.setInt(24, failed(s.outcome()));
                ps.executeUpdate();
                try (ResultSet keys = ps.getGeneratedKeys()) {
                    keys.next();
                    return keys.getLong(1);
                }
            }
        });
        if (id == null) {
            throw new IllegalStateException("SQLite returned no id for a new statement");
        }
        return id;
    }

    /** A continuation chunk of a long result: its rows from {@code rowsFrom}, and the outcome as now known. */
    private void appendRows(long id, IncomingStatement s) {
        long bytes = insertRows(id, RESULT, s.rowsFrom(), s.rows());
        long added = s.rows() == null ? 0 : s.rows().size();
        String outcome = json(s.outcome());
        jdbcTemplate.update("UPDATE statements SET outcome_json = ?, failed = ?, stored_rows = stored_rows + ?, approx_bytes = approx_bytes + ?,"
                + " duration_us = MAX(duration_us, ?) WHERE id = ?", outcome, failed(s.outcome()), added, bytes, s.durationMicros(), id);
    }

    private static int failed(StatementOutcome outcome) {
        return outcome != null && outcome.failed() ? 1 : 0;
    }

    private long insertRows(long statementId, String part, int from, List<List<TypedValue>> rows) {
        if (rows == null || rows.isEmpty()) {
            return 0;
        }
        List<Object[]> args = new ArrayList<>(rows.size());
        long bytes = 0;
        for (int i = 0; i < rows.size(); i++) {
            String values = json(rows.get(i));
            bytes += values.length();
            args.add(new Object[]{statementId, part, from + i, values});
        }
        jdbcTemplate.batchUpdate("INSERT OR IGNORE INTO result_rows (statement_id, part, row_index, values_json) VALUES (?,?,?,?)", args);
        return bytes;
    }

    @Override
    public void saveMarkers(List<CallMarker> markers) {
        if (markers == null || markers.isEmpty()) {
            return;
        }
        List<Object[]> args = markers.stream()
                .map(m -> new Object[]{m.callId(), m.seq(), m.type().name(), m.at() == null ? Instant.now().toString() : m.at(), m.method(), m.url(), m.thread(),
                        Boolean.TRUE.equals(m.logs()) ? 1 : null})
                .toList();
        jdbcTemplate.batchUpdate("INSERT OR IGNORE INTO call_markers (call_id, seq, type, at, method, url, thread, logs) VALUES (?,?,?,?,?,?,?,?)", args);
    }

    // ------------------------------------------------------------------ caught log lines (specs/009-agent-log-capture)

    /** Outside-call lines kept per project (spec FR-015) - the oldest go first. */
    static final int MAX_OUTSIDE_LOG_LINES = 20_000;
    private static final String LOG_COLUMNS = "id, call_id, seq, at, level, logger, thread, message, exception_json, cut, project";

    @Override
    public void saveLogLines(List<CaughtLogLine> lines) {
        if (lines == null || lines.isEmpty()) {
            return;
        }
        transactions.executeWithoutResult(status -> {
            List<Object[]> args = lines.stream().map(l -> new Object[]{l.callId(), l.callId() == null ? 0 : l.seq(), at(l.at()), atMs(l.at()), l.level(),
                    l.logger(), l.thread(), l.message(), exceptionJson(l), l.cut() ? 1 : 0, l.project(), approxBytes(l)}).toList();
            jdbcTemplate.batchUpdate("INSERT INTO call_log_lines (call_id, seq, at, at_ms, level, logger, thread, message, exception_json, cut, project, approx_bytes) "
                    + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", args);
            Map<String, int[]> perCall = new LinkedHashMap<>();
            for (CaughtLogLine l : lines) {
                if (l.callId() != null) {
                    int[] c = perCall.computeIfAbsent(l.callId(), k -> new int[3]);
                    c[0]++;
                    c[1] += l.error() ? 1 : 0;
                    c[2] += l.warning() ? 1 : 0;
                }
            }
            for (Map.Entry<String, int[]> e : perCall.entrySet()) {
                jdbcTemplate.update("INSERT INTO call_log_summary (call_id, lines, errors, warnings) VALUES (?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET "
                        + "lines = lines + excluded.lines, errors = errors + excluded.errors, warnings = warnings + excluded.warnings",
                        e.getKey(), e.getValue()[0], e.getValue()[1], e.getValue()[2]);
            }
        });
        lines.stream().filter(l -> l.callId() == null).map(CaughtLogLine::project).distinct().forEach(this::trimOutsideLogLines);
    }

    private void trimOutsideLogLines(String project) {
        Long cut = jdbcTemplate.query("SELECT id FROM call_log_lines WHERE call_id IS NULL AND project IS ? ORDER BY id DESC LIMIT 1 OFFSET ?",
                (rs, n) -> rs.getLong(1), project, MAX_OUTSIDE_LOG_LINES).stream().findFirst().orElse(null);
        if (cut != null) {
            jdbcTemplate.update("DELETE FROM call_log_lines WHERE call_id IS NULL AND project IS ? AND id <= ?", project, cut);
        }
    }

    @Override
    public List<CaughtLogLine> logLines(String callId, int afterSeq, int limit) {
        return jdbcTemplate.query("SELECT " + LOG_COLUMNS + " FROM call_log_lines WHERE call_id = ? AND seq > ? ORDER BY seq, id LIMIT ?",
                this::logLine, callId, afterSeq, limit);
    }

    @Override
    public List<CaughtLogLine> outsideLogLines(String project, String thread, long afterId, int limit) {
        return thread == null || thread.isBlank()
                ? jdbcTemplate.query("SELECT " + LOG_COLUMNS + " FROM call_log_lines WHERE call_id IS NULL AND project IS ? AND id > ? ORDER BY id LIMIT ?",
                        this::logLine, project, afterId, limit)
                : jdbcTemplate.query("SELECT " + LOG_COLUMNS + " FROM call_log_lines WHERE call_id IS NULL AND project IS ? AND thread = ? AND id > ? ORDER BY id LIMIT ?",
                        this::logLine, project, thread, afterId, limit);
    }

    @Override
    public void addDroppedLogs(Map<String, Long> droppedByCall) {
        if (droppedByCall == null) {
            return;
        }
        droppedByCall.forEach((callId, n) -> {
            if (callId != null && n != null && n > 0) {
                jdbcTemplate.update("INSERT INTO call_log_summary (call_id, dropped) VALUES (?,?) ON CONFLICT(call_id) DO UPDATE SET dropped = dropped + excluded.dropped",
                        callId, n);
            }
        });
    }

    @Override
    public Map<String, CaughtLogCounts> logCounts(Collection<String> callIds) {
        Map<String, CaughtLogCounts> out = new LinkedHashMap<>();
        List<String> ids = new ArrayList<>(callIds);
        for (int i = 0; i < ids.size(); i += IN_CHUNK) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + IN_CHUNK));
            String in = chunk.stream().map(x -> "?").collect(Collectors.joining(","));
            jdbcTemplate.query("SELECT call_id, lines, errors, warnings, dropped FROM call_log_summary WHERE call_id IN (" + in + ")",
                    rs -> {
                        out.put(rs.getString(1), new CaughtLogCounts(rs.getInt(2), rs.getInt(3), rs.getInt(4), rs.getInt(5)));
                    }, chunk.toArray());
        }
        return out;
    }

    @Override
    public boolean catchesLogs(String callId) {
        return !jdbcTemplate.queryForList("SELECT 1 FROM call_markers WHERE call_id = ? AND seq = 0 AND logs = 1 LIMIT 1", Integer.class, callId).isEmpty()
                || !jdbcTemplate.queryForList("SELECT 1 FROM call_log_lines WHERE call_id = ? LIMIT 1", Integer.class, callId).isEmpty();
    }

    @Override
    public void deleteLogLines(String callId) {
        transactions.executeWithoutResult(status -> {
            jdbcTemplate.update("DELETE FROM call_log_lines WHERE call_id = ?", callId);
            jdbcTemplate.update("DELETE FROM call_log_summary WHERE call_id = ?", callId);
        });
    }

    private CaughtLogLine logLine(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        String type = null;
        String message = null;
        String stack = null;
        String exception = rs.getString("exception_json");
        if (exception != null) {
            try {
                Map<?, ?> e = objectMapper.readValue(exception, Map.class);
                type = (String) e.get("type");
                message = (String) e.get("message");
                stack = (String) e.get("stack");
            } catch (Exception ignored) {
                stack = exception;
            }
        }
        return new CaughtLogLine(rs.getLong("id"), rs.getString("call_id"), rs.getInt("seq"), rs.getString("at"), rs.getString("level"),
                rs.getString("logger"), rs.getString("thread"), rs.getString("message"), type, message, stack, rs.getInt("cut") == 1,
                rs.getString("project"));
    }

    private String exceptionJson(CaughtLogLine l) {
        if (l.exceptionType() == null && l.exceptionMessage() == null && l.exceptionStack() == null) {
            return null;
        }
        Map<String, String> e = new LinkedHashMap<>();
        e.put("type", l.exceptionType());
        e.put("message", l.exceptionMessage());
        e.put("stack", l.exceptionStack());
        return json(e);
    }

    /** The agent writes a fixed 3-digit fraction already; anything else is normalised so text order stays time order. */
    private static final java.time.format.DateTimeFormatter AT_MILLIS =
            java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC);

    private static String at(String at) {
        return AT_MILLIS.format(Instant.ofEpochMilli(atMs(at)));
    }

    private static long atMs(String at) {
        try {
            return Instant.parse(at).toEpochMilli();
        } catch (RuntimeException e) {
            return Instant.now().toEpochMilli();
        }
    }

    private static long approxBytes(CaughtLogLine l) {
        long n = 64;
        for (String s : new String[]{l.level(), l.logger(), l.thread(), l.message(), l.exceptionType(), l.exceptionMessage(), l.exceptionStack()}) {
            n += s == null ? 0 : s.length() * 2L;
        }
        return n;
    }

    @Override
    public Optional<String> requestThread(String callId) {
        List<String> open = jdbcTemplate.queryForList(
                "SELECT thread FROM call_markers WHERE call_id = ? AND seq = 0 AND thread IS NOT NULL LIMIT 1", String.class, callId);
        if (!open.isEmpty()) {
            return Optional.of(open.get(0));
        }
        // Captured before the CALL_OPEN marker carried it: the thread of the call's first statement.
        return jdbcTemplate.queryForList("SELECT thread_name FROM statements WHERE call_id = ? ORDER BY seq LIMIT 1", String.class, callId)
                .stream().filter(Objects::nonNull).findFirst();
    }

    @Override
    public List<CallOnThread> callsOnThread(String thread, String fromInstant, String toInstant) {
        Instant from = Instant.parse(fromInstant);
        Instant to = Instant.parse(toInstant);
        // `at` is Instant.toString(), whose fraction varies in length ("…:00Z" sorts after "…:00.5Z"): the rows are
        // narrowed by their whole-second prefix (fixed length, so text order is time order), then compared exactly.
        return jdbcTemplate.query("SELECT call_id, at FROM call_markers WHERE seq = 0 AND thread = ? AND substr(at, 1, 19) BETWEEN ? AND ? LIMIT ?",
                        (rs, i) -> new CallOnThread(rs.getString(1), rs.getString(2)), thread, second(from), second(to), MAX_CALLS_ON_THREAD)
                .stream().filter(c -> within(c, from, to)).sorted(Comparator.comparing(SqliteDbCaptureRepository::openedAt)).toList();
    }

    @Override
    public List<CallOnThread> callsBefore(String thread, String beforeInstant, int limit) {
        Instant before = Instant.parse(beforeInstant);
        // a few more than asked: calls in the same second are ordered exactly here, not by their text
        return jdbcTemplate.query("SELECT call_id, at FROM call_markers WHERE seq = 0 AND thread = ? AND substr(at, 1, 19) <= ? "
                                + "ORDER BY substr(at, 1, 19) DESC LIMIT ?",
                        (rs, i) -> new CallOnThread(rs.getString(1), rs.getString(2)), thread, second(before), limit + 20)
                .stream().filter(c -> openedAt(c) != null && openedAt(c).isBefore(before))
                .sorted(Comparator.comparing(SqliteDbCaptureRepository::openedAt).reversed()).limit(limit).toList();
    }

    /** At most this many calls on one thread in one window - windows are a call's length, so far fewer in practice. */
    static final int MAX_CALLS_ON_THREAD = 1000;

    private static String second(Instant instant) {
        return instant.toString().substring(0, 19);
    }

    private static Instant openedAt(CallOnThread c) {
        try {
            return Instant.parse(c.openedAt());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static boolean within(CallOnThread c, Instant from, Instant to) {
        Instant at = openedAt(c);
        return at != null && !at.isBefore(from) && !at.isAfter(to);
    }

    @Override
    public void addDropped(Map<String, Long> droppedByCall) {
        if (droppedByCall == null) {
            return;
        }
        droppedByCall.forEach((callId, count) -> {
            if (callId != null && count != null && count > 0) {
                jdbcTemplate.update("UPDATE call_db_summary SET dropped_count = dropped_count + ? WHERE call_id = ?", count, callId);
            }
        });
    }

    @Override
    public void refreshTransactions(String callId) {
        List<TxRow> rows = jdbcTemplate.query(
                "SELECT tx_id, kind, seq, outcome_json, connection_id FROM statements WHERE call_id = ? AND tx_id IS NOT NULL ORDER BY seq LIMIT 100000",
                (rs, n) -> new TxRow(rs.getString("tx_id"), StatementKind.valueOf(rs.getString("kind")), rs.getInt("seq"),
                        rs.getString("outcome_json"), rs.getString("connection_id")), callId);
        Map<String, List<TxRow>> byTx = rows.stream().collect(Collectors.groupingBy(TxRow::txId, LinkedHashMap::new, Collectors.toList()));
        for (Map.Entry<String, List<TxRow>> entry : byTx.entrySet()) {
            List<TxRow> tx = entry.getValue();
            String outcome = StatementTransaction.OPEN;
            long held = 0;
            TxRow last = tx.get(tx.size() - 1);
            StatementOutcome end = null;
            if (last.kind() == StatementKind.COMMIT || last.kind() == StatementKind.ROLLBACK) {
                end = read(last.outcomeJson(), StatementOutcome.class);
                outcome = last.kind() == StatementKind.COMMIT ? StatementTransaction.COMMITTED : StatementTransaction.ROLLED_BACK;
                held = end.heldMicros() == null ? 0 : end.heldMicros();
            }
            Long acquire = read(tx.get(0).outcomeJson(), StatementOutcome.class).acquireMicros();
            TxLifecycle lifecycle = end == null && acquire == null ? null
                    : new TxLifecycle(end == null ? null : end.via(), acquire, end == null ? null : end.beginMicros(),
                    end == null ? null : end.commitMicros(), end == null ? null : end.closeMicros());
            int writes = (int) tx.stream().filter(r -> r.kind().isWrite()).count();
            jdbcTemplate.update("""
                    INSERT INTO transactions (call_id, tx_id, connection_id, first_seq, last_seq, outcome, held_us, statement_count, write_count,
                      lifecycle_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(call_id, tx_id) DO UPDATE SET connection_id = excluded.connection_id, first_seq = excluded.first_seq,
                      last_seq = excluded.last_seq, outcome = excluded.outcome, held_us = excluded.held_us,
                      statement_count = excluded.statement_count, write_count = excluded.write_count, lifecycle_json = excluded.lifecycle_json
                    """, callId, entry.getKey(), tx.get(0).connectionId(), tx.get(0).seq(), last.seq(), outcome, held, tx.size(), writes,
                    lifecycle == null ? null : json(lifecycle));
            if (StatementTransaction.ROLLED_BACK.equals(outcome)) {
                jdbcTemplate.update("UPDATE statements SET undone = 1 WHERE call_id = ? AND tx_id = ? AND kind NOT IN ('COMMIT','ROLLBACK','SAVEPOINT','ROLLBACK_TO_SAVEPOINT')",
                        callId, entry.getKey());
            }
        }
    }

    private record TxRow(String txId, StatementKind kind, int seq, String outcomeJson, String connectionId) {
    }

    @Override
    public void refreshSummary(String callId) {
        Map<String, Object> counts = jdbcTemplate.queryForMap("""
                SELECT COUNT(*) AS statements,
                       COALESCE(SUM(CASE WHEN kind IN ('INSERT','UPDATE','DELETE','MERGE') THEN 1 ELSE 0 END), 0) AS writes,
                       COALESCE(SUM(CASE WHEN kind = 'DELETE' THEN 1 ELSE 0 END), 0) AS deletes,
                       COALESCE(SUM(failed), 0) AS failed,
                       COALESCE(SUM(duration_us), 0) AS db_us,
                       COALESCE(MAX(seq), 0) AS last_seq
                FROM statements WHERE call_id = ?
                """, callId);
        Map<String, Object> markers = jdbcTemplate.queryForMap(
                "SELECT COUNT(*) AS markers, COALESCE(MAX(seq), 0) AS last_seq FROM call_markers WHERE call_id = ?", callId);
        long statementCount = ((Number) counts.get("statements")).longValue();
        if (statementCount == 0 && ((Number) markers.get("markers")).longValue() == 0) {
            return;
        }
        Map<String, Object> txCounts = jdbcTemplate.queryForMap(
                "SELECT COUNT(*) AS tx, COALESCE(SUM(CASE WHEN outcome = 'ROLLED_BACK' THEN 1 ELSE 0 END), 0) AS rolled FROM transactions WHERE call_id = ?",
                callId);
        int lastSeq = Math.max(((Number) counts.get("last_seq")).intValue(), ((Number) markers.get("last_seq")).intValue());
        jdbcTemplate.update("""
                INSERT INTO call_db_summary (call_id, statement_count, write_count, delete_count, failed_count, tx_count, rolled_back_count,
                  db_us, last_seq, first_seen)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(call_id) DO UPDATE SET statement_count = excluded.statement_count, write_count = excluded.write_count,
                  delete_count = excluded.delete_count, failed_count = excluded.failed_count, tx_count = excluded.tx_count,
                  rolled_back_count = excluded.rolled_back_count, db_us = excluded.db_us, last_seq = excluded.last_seq
                """,
                callId, statementCount, counts.get("writes"), counts.get("deletes"), counts.get("failed"),
                txCounts.get("tx"), txCounts.get("rolled"), counts.get("db_us"), lastSeq, Instant.now().toString());
    }

    /** @return true when the column was added just now. */
    private boolean addColumnIfMissing(String table, String column, String type) {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(" + table + ")", (rs, n) -> rs.getString("name"));
        if (!columns.contains(column)) {
            jdbcTemplate.execute("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
            return true;
        }
        return false;
    }

    @Override
    public void setCallProject(String callId, String project) {
        jdbcTemplate.update("UPDATE call_db_summary SET project = ? WHERE call_id = ? AND project IS NULL", project, callId);
    }

    @Override
    public Optional<String> callProject(String callId) {
        List<String> found = jdbcTemplate.queryForList("SELECT project FROM call_db_summary WHERE call_id = ? AND project IS NOT NULL", String.class, callId);
        return found.stream().findFirst();
    }

    @Override
    public void saveFlags(String callId, List<DbFlag> flags) {
        jdbcTemplate.update("UPDATE call_db_summary SET flags_json = ?, flags_version = ? WHERE call_id = ?", json(flags), StatementFlags.VERSION, callId);
    }

    @Override
    public void markComplete(String callId, boolean endedEarly) {
        jdbcTemplate.update("UPDATE call_db_summary SET complete = 1, ended_early = ? WHERE call_id = ?", endedEarly ? 1 : 0, callId);
    }

    @Override
    public void markFailuresSwallowed(String callId, boolean swallowed) {
        jdbcTemplate.update("UPDATE statements SET outcome_json = json_set(outcome_json, '$.swallowed', json(?)) "
                + "WHERE call_id = ? AND failed = 1", swallowed ? "true" : "false", callId);
    }

    @Override
    public Map<String, List<CapturedStatement>> failedStatements(Collection<String> callIds, int perCall) {
        Map<String, List<CapturedStatement>> result = new LinkedHashMap<>();
        List<String> ids = new ArrayList<>(callIds);
        for (int i = 0; i < ids.size(); i += IN_CHUNK) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + IN_CHUNK));
            String in = chunk.stream().map(x -> "?").collect(Collectors.joining(","));
            // ix_statements_failed holds only failed rows: this never touches a call's successful statements.
            jdbcTemplate.query("SELECT " + STATEMENT_COLUMNS + " FROM statements INDEXED BY ix_statements_failed WHERE failed = 1 AND call_id IN ("
                            + in + ") ORDER BY call_id, seq", statementMapper, chunk.toArray())
                    .forEach(st -> {
                        List<CapturedStatement> list = result.computeIfAbsent(st.callId(), k -> new ArrayList<>());
                        if (list.size() < perCall) {
                            list.add(st);
                        }
                    });
        }
        return result;
    }

    @Override
    public FailureCounts failureCounts(String callId) {
        return jdbcTemplate.queryForObject("SELECT COUNT(*) AS failed, COALESCE(SUM(CASE WHEN json_extract(outcome_json, '$.swallowed') = 1 THEN 1 ELSE 0 END), 0)"
                        + " AS swallowed FROM statements INDEXED BY ix_statements_failed WHERE call_id = ? AND failed = 1",
                (rs, n) -> new FailureCounts(rs.getInt("failed"), rs.getInt("swallowed")), callId);
    }

    @Override
    public List<String> callIdsOfRuns(Collection<String> runIds) {
        List<String> result = new ArrayList<>();
        for (String runId : runIds) {
            if (runId == null || runId.isBlank()) {
                continue;
            }
            // run_tag is "<runId>/<stepKey>"; escape LIKE wildcards in the id.
            String prefix = runId.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "/%";
            result.addAll(jdbcTemplate.queryForList("SELECT DISTINCT call_id FROM statements WHERE call_id IS NOT NULL AND run_tag LIKE ? ESCAPE '!'",
                    String.class, prefix));
        }
        return result;
    }

    // ------------------------------------------------------------------ reads

    private final RowMapper<CallDbSummary> summaryMapper = (rs, n) -> new CallDbSummary(
            rs.getString("call_id"), rs.getInt("statement_count"), rs.getInt("write_count"), rs.getInt("delete_count"),
            rs.getInt("failed_count"), rs.getInt("tx_count"), rs.getInt("rolled_back_count"), rs.getLong("db_us"),
            rs.getLong("dropped_count"), read(rs.getString("flags_json"), FLAGS), rs.getInt("last_seq"),
            rs.getInt("complete") != 0, rs.getInt("ended_early") != 0);

    private static final String SUMMARY_COLUMNS = "call_id, statement_count, write_count, delete_count, failed_count, tx_count, "
            + "rolled_back_count, db_us, dropped_count, flags_json, last_seq, complete, ended_early";

    @Override
    public List<String> withStaleFlags(Collection<String> callIds) {
        if (callIds == null || callIds.isEmpty()) {
            return List.of();
        }
        String in = String.join(",", java.util.Collections.nCopies(callIds.size(), "?"));
        List<Object> args = new ArrayList<>(callIds);
        args.add(StatementFlags.VERSION);
        return jdbcTemplate.queryForList("SELECT call_id FROM call_db_summary WHERE call_id IN (" + in + ") AND flags_version < ?", String.class, args.toArray());
    }

    @Override
    public Map<String, CallDbSummary> summaries(Collection<String> callIds) {
        Map<String, CallDbSummary> result = new HashMap<>();
        List<String> ids = new ArrayList<>(callIds);
        for (int i = 0; i < ids.size(); i += IN_CHUNK) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + IN_CHUNK));
            String in = chunk.stream().map(x -> "?").collect(Collectors.joining(","));
            jdbcTemplate.query("SELECT " + SUMMARY_COLUMNS + " FROM call_db_summary WHERE call_id IN (" + in + ") LIMIT " + chunk.size(),
                    summaryMapper, chunk.toArray()).forEach(s -> result.put(s.callId(), s));
        }
        return result;
    }

    @Override
    public Optional<CallDbSummary> summary(String callId) {
        return jdbcTemplate.query("SELECT " + SUMMARY_COLUMNS + " FROM call_db_summary WHERE call_id = ? LIMIT 1", summaryMapper, callId)
                .stream().findFirst();
    }

    private final RowMapper<CapturedStatement> statementMapper = (rs, n) -> new CapturedStatement(
            rs.getLong("id"), rs.getString("call_id"), rs.getString("thread_name"), rs.getInt("seq"),
            StatementKind.valueOf(rs.getString("kind")), rs.getString("sql"), rs.getString("fingerprint"), rs.getString("table_name"),
            read(rs.getString("params_json"), VALUE_ROWS), read(rs.getString("outcome_json"), StatementOutcome.class),
            rs.getString("started_at"), rs.getLong("duration_us"), rs.getLong("offset_us"), rs.getString("tx_id"),
            rs.getString("connection_id"), rs.getString("code_location"), rs.getString("run_tag"), rs.getString("data_source"),
            readNullable(rs.getString("before_json"), BeforeImage.class),
            rs.getString("cascades_json") == null ? null : read(rs.getString("cascades_json"), STRINGS),
            rs.getInt("undone") != 0, rs.getInt("expected") != 0, rs.getLong("stored_rows"),
            readNullable(rs.getString("origin_json"), StatementOrigin.class),
            rs.getString("callers_json") == null ? null : read(rs.getString("callers_json"), STRINGS),
            rs.getString("indexes_json") == null ? null : read(rs.getString("indexes_json"), INDEXES));

    @Override
    public List<CapturedStatement> statementsAfter(String callId, int afterSeq, int limit) {
        return jdbcTemplate.query("SELECT " + STATEMENT_COLUMNS + " FROM statements WHERE call_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                statementMapper, callId, afterSeq, limit);
    }

    @Override
    public List<CapturedStatement> allStatements(String callId, int limit) {
        return statementsAfter(callId, -1, limit);
    }

    @Override
    public List<CapturedStatement> outsideStatements(String thread, int offset, int limit) {
        if (thread == null || thread.isBlank()) {
            return jdbcTemplate.query("SELECT " + STATEMENT_COLUMNS + " FROM statements WHERE call_id IS NULL ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
                    statementMapper, limit, offset);
        }
        return jdbcTemplate.query("SELECT " + STATEMENT_COLUMNS + " FROM statements WHERE call_id IS NULL AND thread_name = ? ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
                statementMapper, thread, limit, offset);
    }

    @Override
    public List<StatementTransaction> transactions(String callId) {
        return jdbcTemplate.query("SELECT call_id, tx_id, connection_id, first_seq, last_seq, outcome, held_us, statement_count, write_count, "
                        + "lifecycle_json FROM transactions WHERE call_id = ? ORDER BY first_seq LIMIT 10000",
                (rs, n) -> new StatementTransaction(rs.getString("call_id"), rs.getString("tx_id"), rs.getString("connection_id"),
                        rs.getInt("first_seq"), rs.getInt("last_seq"), rs.getString("outcome"), rs.getLong("held_us"),
                        rs.getInt("statement_count"), rs.getInt("write_count"), readNullable(rs.getString("lifecycle_json"), TxLifecycle.class)), callId);
    }

    @Override
    public List<CallMarker> markers(String callId) {
        return jdbcTemplate.query("SELECT call_id, seq, type, at, method, url, thread, logs FROM call_markers WHERE call_id = ? ORDER BY seq LIMIT 10000",
                (rs, n) -> new CallMarker(rs.getString("call_id"), rs.getInt("seq"), MarkerType.valueOf(rs.getString("type")),
                        rs.getString("at"), rs.getString("method"), rs.getString("url"), rs.getString("thread"),
                        rs.getInt("logs") == 1 ? Boolean.TRUE : null), callId);
    }

    @Override
    public Optional<CapturedStatement> statement(long id) {
        return jdbcTemplate.query("SELECT " + STATEMENT_COLUMNS + " FROM statements WHERE id = ? LIMIT 1", statementMapper, id).stream().findFirst();
    }

    @Override
    public List<Column> columns(long statementId, String part) {
        Optional<CapturedStatement> statement = statement(statementId);
        if (statement.isEmpty()) {
            return List.of();
        }
        if (BEFORE_IMAGE.equals(part)) {
            BeforeImage before = statement.get().beforeImage();
            return before == null || before.columns() == null ? List.of() : before.columns();
        }
        StatementOutcome outcome = statement.get().outcome();
        return outcome == null || outcome.columns() == null ? List.of() : outcome.columns();
    }

    @Override
    public List<List<TypedValue>> rows(long statementId, String part, int offset, int limit) {
        return jdbcTemplate.query("SELECT values_json FROM result_rows WHERE statement_id = ? AND part = ? AND row_index >= ? ORDER BY row_index LIMIT ?",
                (rs, n) -> read(rs.getString("values_json"), VALUE_ROW), statementId, part, offset, limit);
    }

    @Override
    public List<TraceHit> rowsContaining(String callId, String value, int limit) {
        // A cheap LIKE narrows to rows that mention the value; the exact cell match happens here.
        String needle = "%" + value.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
        List<TraceHit> hits = new ArrayList<>();
        jdbcTemplate.query("""
                SELECT s.seq, r.part, r.row_index, r.values_json FROM result_rows r JOIN statements s ON s.id = r.statement_id
                WHERE s.call_id = ? AND r.values_json LIKE ? ESCAPE '!' ORDER BY s.seq, r.part, r.row_index LIMIT ?
                """, rs -> {
            List<TypedValue> row = read(rs.getString("values_json"), VALUE_ROW);
            for (int i = 0; i < row.size(); i++) {
                if (value.equals(row.get(i).value())) {
                    hits.add(new TraceHit(rs.getInt("seq"), BEFORE_IMAGE.equals(rs.getString("part")) ? TraceHit.BEFORE_IMAGE : TraceHit.ROW,
                            rs.getInt("row_index"), String.valueOf(i)));
                }
            }
        }, callId, needle, limit);
        return hits;
    }

    @Override
    public long rowCount(long statementId, String part) {
        Long count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM result_rows WHERE statement_id = ? AND part = ?", Long.class, statementId, part);
        return count == null ? 0 : count;
    }

    // ------------------------------------------------------------------ deletion and retention

    @Override
    public int deleteForCalls(Collection<String> callIds) {
        List<String> ids = new ArrayList<>(callIds);
        int[] deleted = {0};
        for (int i = 0; i < ids.size(); i += IN_CHUNK) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + IN_CHUNK));
            String in = chunk.stream().map(x -> "?").collect(Collectors.joining(","));
            Object[] args = chunk.toArray();
            transactions.executeWithoutResult(status -> {
                jdbcTemplate.update("DELETE FROM result_rows WHERE statement_id IN (SELECT id FROM statements WHERE call_id IN (" + in + "))", args);
                deleted[0] += jdbcTemplate.update("DELETE FROM statements WHERE call_id IN (" + in + ")", args);
                jdbcTemplate.update("DELETE FROM transactions WHERE call_id IN (" + in + ")", args);
                jdbcTemplate.update("DELETE FROM call_markers WHERE call_id IN (" + in + ")", args);
                jdbcTemplate.update("DELETE FROM call_db_summary WHERE call_id IN (" + in + ")", args);
                jdbcTemplate.update("DELETE FROM call_log_lines WHERE call_id IN (" + in + ")", args);
                jdbcTemplate.update("DELETE FROM call_log_summary WHERE call_id IN (" + in + ")", args);
            });
        }
        return deleted[0];
    }

    @Override
    public void deleteAllCallStatements() {
        transactions.executeWithoutResult(status -> {
            jdbcTemplate.update("DELETE FROM result_rows WHERE statement_id IN (SELECT id FROM statements WHERE call_id IS NOT NULL)");
            jdbcTemplate.update("DELETE FROM statements WHERE call_id IS NOT NULL");
            jdbcTemplate.update("DELETE FROM transactions");
            jdbcTemplate.update("DELETE FROM call_markers");
            jdbcTemplate.update("DELETE FROM call_db_summary");
            jdbcTemplate.update("DELETE FROM call_log_lines WHERE call_id IS NOT NULL");
            jdbcTemplate.update("DELETE FROM call_log_summary");
        });
    }

    @Override
    public long totalBytes() {
        Long bytes = jdbcTemplate.queryForObject("SELECT COALESCE(SUM(approx_bytes), 0) FROM statements", Long.class);
        return bytes == null ? 0 : bytes;
    }

    @Override
    public List<String> oldestCallIds(int limit, Set<String> keep) {
        List<String> result = new ArrayList<>();
        int offset = 0;
        int page = Math.max(limit * 2, 100);
        while (result.size() < limit) {
            List<String> ids = jdbcTemplate.queryForList("SELECT call_id FROM call_db_summary s WHERE NOT EXISTS "
                            + "(SELECT 1 FROM statements r WHERE r.call_id = s.call_id AND r.run_tag IS NOT NULL) "
                            + "ORDER BY first_seen LIMIT ? OFFSET ?",
                    String.class, page, offset);
            if (ids.isEmpty()) {
                break;
            }
            for (String id : ids) {
                if (!keep.contains(id) && result.size() < limit) {
                    result.add(id);
                }
            }
            offset += ids.size();
        }
        return result;
    }

    @Override
    public void trimOutside(String beforeInstant, long maxBytes) {
        transactions.executeWithoutResult(status -> {
            jdbcTemplate.update("DELETE FROM result_rows WHERE statement_id IN (SELECT id FROM statements WHERE call_id IS NULL AND started_at < ?)", beforeInstant);
            jdbcTemplate.update("DELETE FROM statements WHERE call_id IS NULL AND started_at < ?", beforeInstant);
        });
        while (true) {
            Long bytes = jdbcTemplate.queryForObject("SELECT COALESCE(SUM(approx_bytes), 0) FROM statements WHERE call_id IS NULL", Long.class);
            if (bytes == null || bytes <= maxBytes) {
                return;
            }
            List<Long> oldest = jdbcTemplate.queryForList("SELECT id FROM statements WHERE call_id IS NULL ORDER BY started_at, id LIMIT 500", Long.class);
            if (oldest.isEmpty()) {
                return;
            }
            String in = oldest.stream().map(x -> "?").collect(Collectors.joining(","));
            Object[] args = oldest.toArray();
            transactions.executeWithoutResult(status -> {
                jdbcTemplate.update("DELETE FROM result_rows WHERE statement_id IN (" + in + ")", args);
                jdbcTemplate.update("DELETE FROM statements WHERE id IN (" + in + ")", args);
            });
        }
    }

    // ------------------------------------------------------------------ settings and agents

    @Override
    public DbCaptureSettings settings(String project) {
        return jdbcTemplate.queryForList("SELECT settings_json FROM capture_settings WHERE project = ? LIMIT 1", String.class, project)
                .stream().findFirst().map(json -> read(json, DbCaptureSettings.class)).orElseGet(DbCaptureSettings::defaults);
    }

    @Override
    public void saveSettings(String project, DbCaptureSettings settings) {
        jdbcTemplate.update("INSERT INTO capture_settings (project, settings_json) VALUES (?, ?) "
                + "ON CONFLICT(project) DO UPDATE SET settings_json = excluded.settings_json", project, json(settings));
    }

    @Override
    public void saveAgent(AgentStatus status) {
        jdbcTemplate.update("INSERT INTO agents (agent_id, project, status_json, last_seen) VALUES (?,?,?,?) "
                        + "ON CONFLICT(agent_id) DO UPDATE SET project = excluded.project, status_json = excluded.status_json, last_seen = excluded.last_seen",
                status.agentId(), status.project(), json(status), status.lastSeen());
    }

    @Override
    public List<AgentStatus> agents() {
        return jdbcTemplate.query("SELECT status_json FROM agents ORDER BY last_seen DESC LIMIT 200",
                (rs, n) -> read(rs.getString("status_json"), AgentStatus.class));
    }

    // ------------------------------------------------------------------ json

    private String json(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialise a captured statement", e);
        }
    }

    private <T> T read(String json, Class<T> type) {
        try {
            return objectMapper.readValue(json, type);
        } catch (JsonProcessingException e) {
            log.error("Unreadable {} in db-capture.db ({} chars)", type.getSimpleName(), json == null ? 0 : json.length());
            throw new IllegalStateException(e);
        }
    }

    private <T> T read(String json, TypeReference<T> type) {
        try {
            return objectMapper.readValue(json, type);
        } catch (JsonProcessingException e) {
            log.error("Unreadable JSON in db-capture.db ({} chars)", json == null ? 0 : json.length());
            throw new IllegalStateException(e);
        }
    }

    private <T> T readNullable(String json, Class<T> type) {
        return json == null ? null : read(json, type);
    }
}
