package com.fathy.alfred.backend.internalcalls.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallBaseline;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.RecentRequestHeaders;
import com.fathy.alfred.backend.internalcalls.domain.model.ReliveFilter;
import com.fathy.alfred.backend.internalcalls.domain.model.RequestData;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import com.fathy.alfred.backend.internalcalls.domain.model.WsMessage;
import com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage;
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
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The inbound calls store in SQLite ({@code internal-calls.db}) - the default since specs/013-inbound-calls-store.
 *
 * <p>Until then inbound calls lived only in {@code internal-calls.log}, every retained call held in memory: at 7,000
 * calls of ~67 KB that was 835 MB live in a 1 GB heap, and every 3,500 calls a whole-file rewrite (6.7 s on the Docker
 * Desktop mount) blocked every report - stalls long enough to lose a call's first report. Here nothing is held in
 * memory and nothing rewrites all calls: old calls are deleted a few at a time.
 *
 * <p>Modelled on backend-calls' {@code SqliteCallsRepository} (metadata/request/response tables, a trigram FTS index,
 * a single group-commit writer, incremental auto-vacuum, size-based retention) and copied, not shared - slices never
 * share code. Differences that matter:
 * <ul>
 * <li><b>Prepare and complete are order-independent upserts.</b> Prepare writes only the request side, complete only
 * the outcome (filling the identity only where it is still missing). Either order, or a repeat of either - the proxy
 * retries a report whose answer it never got - yields the same single row, and a restart between them loses nothing:
 * the prepared call is on disk, {@code IN_PROGRESS}.</li>
 * <li><b>The search index stores no text.</b> The FTS5 table is contentless ({@code content=''},
 * {@code contentless_delete=1}): it is fed the same fields {@code CallListSupport.matchesSearch} searches, computed in
 * SQL from the stored columns, and never keeps a second copy of every body.</li>
 * <li><b>Retention is by count and by size</b>: the owner's {@code alfred.internal-calls.retention-rows} keeps its
 * meaning, and {@code alfred.storage.internal-calls.max-size-bytes} caps the file.</li>
 * </ul>
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.internal-calls", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteInternalCallsRepository {

    private static final Logger log = LoggerFactory.getLogger(SqliteInternalCallsRepository.class);

    /** What {@code PRAGMA auto_vacuum} returns for INCREMENTAL. */
    private static final int AUTO_VACUUM_INCREMENTAL = 2;
    /** Most calls one retention pass deletes - a pass is a short write transaction, never a rewrite. */
    static final int MAX_TRIM_BATCH = 200;
    /** How often (in writes) the file size is measured against the size cap. */
    private static final int SIZE_CHECK_EVERY_N_WRITES = 50;
    /** Largest page any list query returns (the API clamps lower). */
    private static final int MAX_ROWS = 10_000;
    /** Ids of calls deleted with their Relive run, remembered so a completion still in flight cannot bring one back. */
    private static final int DELETED_IDS_REMEMBERED = 10_000;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${INTERNAL_CALLS_DB_FILE:/appdata/internal-calls.db}")
    private String dbFile;

    @Value("${alfred.storage.internal-calls.max-size-bytes:10737418240}")
    private volatile long maxSizeBytes;

    @Value("${alfred.internal-calls.retention-rows:1500}")
    private volatile int retentionRows;

    @Value("${alfred.internal-calls.ws-max-messages:1000}")
    private int wsMaxMessages;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbcTemplate;
    private BatchWriter<CallRecord> prepareWriter;
    private BatchWriter<Completion> completionWriter;
    private volatile boolean ftsAvailable;
    private int writesSinceSizeCheck;

    private final Set<String> deletedCallIds = Collections.synchronizedSet(Collections.newSetFromMap(
            new LinkedHashMap<>() {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                    return size() > DELETED_IDS_REMEMBERED;
                }
            }));

    /** The outcome half of a call, with the proxy's view of the call for when its prepare never arrived. */
    private record Completion(String id, ResponseData response, String error, Double durationMs,
                              CallInterception interception, Boolean reachedUpstream, CallRecord known) {}

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
        // Per-connection pragmas go in the URL - this driver only runs the first statement of a compound
        // connectionInitSql (see backend-calls' SqliteCallsRepository.init for how that was found).
        // cache_size: 16 MB per connection instead of SQLite's 2 MB. On the Docker Desktop bind mount every page read
        // crosses the VM boundary, and with the metadata of 6,751 calls (~5 MB) not fitting the default cache, paging
        // the live list took 5.5 s for 34 pages; 8-16 MB made it 0.38 s (measured 2026-10-09). Ten connections keep
        // the worst case at 160 MB outside the heap - the container leaves 512 MB there.
        config.setJdbcUrl("jdbc:sqlite:" + path + "?journal_mode=WAL&synchronous=NORMAL&busy_timeout=10000&foreign_keys=true"
                + "&cache_size=-16000");
        config.setMaximumPoolSize(10);
        config.setPoolName("internal-calls-sqlite-pool");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        ensureIncrementalAutoVacuum();
        createSchema();
        initFts();

        List<BatchWriter.StatementSpec<CallRecord>> prepareStatements = new ArrayList<>(List.of(
                new BatchWriter.StatementSpec<>(UPSERT_PREPARED_SQL, this::bindPrepared),
                new BatchWriter.StatementSpec<>(UPSERT_REQUEST_SQL, this::bindRequest)));
        List<BatchWriter.StatementSpec<Completion>> completionStatements = new ArrayList<>(List.of(
                new BatchWriter.StatementSpec<>(UPSERT_COMPLETED_SQL, this::bindCompleted),
                new BatchWriter.StatementSpec<>(UPSERT_RESPONSE_SQL, this::bindResponse)));
        if (ftsAvailable) {
            prepareStatements.add(new BatchWriter.StatementSpec<>(FTS_DELETE_SQL, (ps, c) -> ps.setString(1, c.id())));
            prepareStatements.add(new BatchWriter.StatementSpec<>(FTS_INSERT_SQL, (ps, c) -> ps.setString(1, c.id())));
            completionStatements.add(new BatchWriter.StatementSpec<>(FTS_DELETE_SQL, (ps, c) -> ps.setString(1, c.id())));
            completionStatements.add(new BatchWriter.StatementSpec<>(FTS_INSERT_SQL, (ps, c) -> ps.setString(1, c.id())));
        }
        // Two writers like backend-calls' (one per statement set); SQLite serializes them, and since both are
        // upserts on disjoint columns the order they commit in never changes the row.
        this.prepareWriter = new BatchWriter<>("internal-calls-sqlite-prepare-writer", dataSource, prepareStatements, 1000);
        this.completionWriter = new BatchWriter<>("internal-calls-sqlite-completion-writer", dataSource, completionStatements, 1000);
    }

    /** See backend-calls' SqliteCallsRepository.ensureIncrementalAutoVacuum: without INCREMENTAL the file never shrinks. */
    private void ensureIncrementalAutoVacuum() {
        Integer mode = jdbcTemplate.execute((ConnectionCallback<Integer>) connection -> {
            try (Statement statement = connection.createStatement()) {
                statement.execute("PRAGMA auto_vacuum=INCREMENTAL");
                try (ResultSet rs = statement.executeQuery("PRAGMA auto_vacuum")) {
                    int current = rs.next() ? rs.getInt(1) : -1;
                    if (current == AUTO_VACUUM_INCREMENTAL) {
                        return current;
                    }
                    statement.execute("VACUUM");
                }
                try (ResultSet rs = statement.executeQuery("PRAGMA auto_vacuum")) {
                    return rs.next() ? rs.getInt(1) : -1;
                }
            }
        });
        if (mode == null || mode != AUTO_VACUUM_INCREMENTAL) {
            log.error("internal-calls.db reports auto_vacuum={} - size retention cannot shrink the file", mode);
        }
    }

    private void createSchema() {
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS internal_call_metadata (
                  id TEXT NOT NULL UNIQUE,
                  original_url TEXT,
                  url TEXT,
                  method TEXT,
                  timestamp TEXT,
                  timestamp_millis INTEGER,
                  duration_ms REAL,
                  status INTEGER,
                  status_rank INTEGER NOT NULL DEFAULT -1,
                  status_state TEXT NOT NULL,
                  error TEXT,
                  session_id TEXT,
                  operation_id TEXT,
                  service_name TEXT,
                  supplier TEXT,
                  supplier_name TEXT,
                  interception TEXT,
                  resend_of TEXT,
                  resend_edits TEXT,
                  relive_json TEXT,
                  reached_upstream INTEGER,
                  ws_dropped INTEGER NOT NULL DEFAULT 0,
                  prepared INTEGER NOT NULL DEFAULT 0,
                  completed INTEGER NOT NULL DEFAULT 0
                )""");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS internal_call_request (
                  call_id TEXT PRIMARY KEY REFERENCES internal_call_metadata(id) ON DELETE CASCADE,
                  headers TEXT,
                  body TEXT
                )""");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS internal_call_response (
                  call_id TEXT PRIMARY KEY REFERENCES internal_call_metadata(id) ON DELETE CASCADE,
                  headers TEXT,
                  body TEXT
                )""");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS internal_call_ws_message (
                  call_id TEXT NOT NULL REFERENCES internal_call_metadata(id) ON DELETE CASCADE,
                  seq INTEGER NOT NULL,
                  direction TEXT, ts_millis INTEGER, type TEXT, content TEXT, content_base64 TEXT,
                  original_content TEXT, action TEXT,
                  PRIMARY KEY (call_id, seq)
                )""");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS internal_store_meta (key TEXT PRIMARY KEY, value TEXT)");
        jdbcTemplate.update("INSERT OR IGNORE INTO internal_store_meta (key, value) VALUES ('schema_version', '1')");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_icm_timestamp_millis ON internal_call_metadata(timestamp_millis)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_icm_duration ON internal_call_metadata(duration_ms)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_icm_status_rank ON internal_call_metadata(status_rank)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_icm_status_state ON internal_call_metadata(status_state)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_icm_service_name ON internal_call_metadata(service_name)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_icm_url ON internal_call_metadata(url)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_icm_relive_run ON internal_call_metadata(json_extract(relive_json, '$.runId'))");
    }

    /**
     * Contentless trigram FTS5 - mirrors CallListSupport.matchesSearch's case-insensitive substring semantics for
     * queries of three characters or more without storing the text twice. A build without FTS5/trigram (or
     * contentless_delete) falls back to a scan of the same fields, as backend-calls does.
     */
    private void initFts() {
        try {
            jdbcTemplate.execute("CREATE VIRTUAL TABLE IF NOT EXISTS internal_calls_fts USING fts5("
                    + "haystack, content='', contentless_delete=1, tokenize='trigram')");
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS internal_call_metadata_ad AFTER DELETE ON internal_call_metadata BEGIN
                      DELETE FROM internal_calls_fts WHERE rowid = old.rowid;
                    END""");
            ftsAvailable = true;
        } catch (Exception e) {
            ftsAvailable = false;
            log.warn("FTS5 trigram (contentless) unavailable for internal-calls.db, falling back to a scan: {}", e.getMessage());
        }
    }

    @PreDestroy
    public void close() {
        if (prepareWriter != null) {
            prepareWriter.close();
        }
        if (completionWriter != null) {
            completionWriter.close();
        }
        if (dataSource != null) {
            try {
                jdbcTemplate.execute("PRAGMA wal_checkpoint(TRUNCATE)");
            } catch (Exception ignored) {
                // Best-effort - the pool is closing either way.
            }
            dataSource.close();
        }
    }

    // ------------------------------------------------------------------ writes

    /** The same fields CallListSupport.matchesSearch looks at, joined by newlines, lower-cased. */
    private static final String HAYSTACK_SQL = "lower(coalesce(m.method,'') || char(10) || coalesce(m.original_url,'') || char(10) || "
            + "coalesce(m.url,'') || char(10) || coalesce(m.error,'') || char(10) || coalesce(CAST(m.status AS TEXT),'') || char(10) || "
            + "coalesce(r.headers,'') || char(10) || coalesce(r.body,'') || char(10) || coalesce(q.headers,'') || char(10) || coalesce(q.body,''))";

    private static final String FTS_DELETE_SQL =
            "DELETE FROM internal_calls_fts WHERE rowid = (SELECT rowid FROM internal_call_metadata WHERE id = ?)";

    private static final String FTS_INSERT_SQL = "INSERT INTO internal_calls_fts (rowid, haystack) SELECT m.rowid, " + HAYSTACK_SQL
            + " FROM internal_call_metadata m LEFT JOIN internal_call_request q ON q.call_id = m.id"
            + " LEFT JOIN internal_call_response r ON r.call_id = m.id WHERE m.id = ?";

    /**
     * The rowid a new call gets: always positive. Calls moved from internal-calls.log sit at negative rowids (see
     * insertMigrated), and SQLite's own choice - max + 1 - would land a new call inside that range while only moved
     * calls exist, colliding with a call the move has yet to write.
     */
    private static final String NEXT_ROWID = "(SELECT max(coalesce(max(rowid), 0), 0) + 1 FROM internal_call_metadata)";

    /** The request side only; an outcome already stored (the completion came first) is kept. */
    private static final String UPSERT_PREPARED_SQL = """
            INSERT INTO internal_call_metadata (rowid, id, original_url, url, method, timestamp, timestamp_millis, status_state,
                session_id, operation_id, service_name, supplier, supplier_name, resend_of, resend_edits, relive_json, prepared)
            VALUES (""" + NEXT_ROWID + """
            ,?,?,?,?,?,?,'IN_PROGRESS',?,?,?,?,?,?,?,?,1)
            ON CONFLICT(id) DO UPDATE SET original_url = excluded.original_url, url = excluded.url, method = excluded.method,
                timestamp = excluded.timestamp, timestamp_millis = excluded.timestamp_millis, session_id = excluded.session_id,
                operation_id = excluded.operation_id, service_name = excluded.service_name, supplier = excluded.supplier,
                supplier_name = excluded.supplier_name, resend_of = excluded.resend_of, resend_edits = excluded.resend_edits,
                relive_json = excluded.relive_json, prepared = 1
            """;

    private static final String UPSERT_REQUEST_SQL = "INSERT INTO internal_call_request (call_id, headers, body) VALUES (?,?,?) "
            + "ON CONFLICT(call_id) DO UPDATE SET headers = excluded.headers, body = excluded.body";

    /** The outcome side only; the identity fills in only what a prepare has not already written. */
    private static final String UPSERT_COMPLETED_SQL = """
            INSERT INTO internal_call_metadata (rowid, id, original_url, url, method, timestamp, timestamp_millis, session_id,
                operation_id, service_name, supplier, duration_ms, status, status_rank, status_state, error, interception,
                reached_upstream, completed)
            VALUES (""" + NEXT_ROWID + """
            ,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
            ON CONFLICT(id) DO UPDATE SET duration_ms = excluded.duration_ms, status = excluded.status,
                status_rank = excluded.status_rank, status_state = excluded.status_state, error = excluded.error,
                interception = excluded.interception, reached_upstream = excluded.reached_upstream, completed = 1,
                original_url = coalesce(internal_call_metadata.original_url, excluded.original_url),
                url = coalesce(internal_call_metadata.url, excluded.url),
                method = coalesce(internal_call_metadata.method, excluded.method),
                timestamp = coalesce(internal_call_metadata.timestamp, excluded.timestamp),
                timestamp_millis = coalesce(internal_call_metadata.timestamp_millis, excluded.timestamp_millis),
                session_id = coalesce(internal_call_metadata.session_id, excluded.session_id),
                operation_id = coalesce(internal_call_metadata.operation_id, excluded.operation_id),
                service_name = coalesce(internal_call_metadata.service_name, excluded.service_name),
                supplier = CASE WHEN internal_call_metadata.prepared = 1 THEN internal_call_metadata.supplier ELSE excluded.supplier END
            """;

    private static final String UPSERT_RESPONSE_SQL = "INSERT INTO internal_call_response (call_id, headers, body) VALUES (?,?,?) "
            + "ON CONFLICT(call_id) DO UPDATE SET headers = excluded.headers, body = excluded.body";

    /** Writes a call's request side. Returns true when its completion was already stored (a late or repeated prepare). */
    public boolean prepare(CallRecord call) {
        Integer completed = single("SELECT completed FROM internal_call_metadata WHERE id = ?", Integer.class, call.id());
        write(call.id(), () -> prepareWriter.submit(call));
        afterWrite();
        return completed != null && completed == 1;
    }

    /**
     * Writes a call's outcome. Returns true when the call had been prepared; false for a completion without its prepare
     * (still stored, from {@code known}) and for a call deleted with its Relive run while in flight (not stored).
     */
    public boolean complete(String id, ResponseData response, String error, Double durationMs,
                            CallInterception interception, Boolean reachedUpstream, CallRecord known) {
        if (deletedCallIds.contains(id)) {
            return false;
        }
        Integer prepared = single("SELECT prepared FROM internal_call_metadata WHERE id = ?", Integer.class, id);
        write(id, () -> completionWriter.submit(new Completion(id, response, error, durationMs, interception, reachedUpstream, known)));
        afterWrite();
        return prepared != null && prepared == 1;
    }

    /**
     * A write that fails (disk full, database error) is logged and rethrown: the webhook then answers 500 and the proxy
     * retries the report (FR-014) - never a 2xx for a call that was not stored.
     */
    private static void write(String callId, Runnable submit) {
        try {
            submit.run();
        } catch (RuntimeException e) {
            log.error("Could not store inbound call {}: {}", callId, e.getCause() != null ? e.getCause().getMessage() : e.getMessage());
            throw e;
        }
    }

    /** The request side of a call moved from internal-calls.log, at an explicit (negative) rowid - see insertMigrated. */
    private static final String UPSERT_MIGRATED_SQL = UPSERT_PREPARED_SQL.replace(NEXT_ROWID, "?");

    /**
     * Calls copied from internal-calls.log, oldest first, in one short transaction, at rowids {@code firstRowid},
     * {@code firstRowid + 1}, ... The move runs while new calls are being stored, so the moved ones get negative rowids:
     * they sort before every new call (rowid is the list's order) and retention removes them first. Upserts, so a call
     * already copied by an interrupted run keeps its row and is simply written again.
     */
    public void insertMigrated(List<CallRecord> calls, long firstRowid) {
        if (calls.isEmpty()) {
            return;
        }
        jdbcTemplate.execute((ConnectionCallback<Void>) connection -> {
            boolean autoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try (PreparedStatement prepared = connection.prepareStatement(UPSERT_MIGRATED_SQL);
                 PreparedStatement request = connection.prepareStatement(UPSERT_REQUEST_SQL);
                 PreparedStatement completed = connection.prepareStatement(UPSERT_COMPLETED_SQL);
                 PreparedStatement response = connection.prepareStatement(UPSERT_RESPONSE_SQL);
                 PreparedStatement ftsDelete = ftsAvailable ? connection.prepareStatement(FTS_DELETE_SQL) : null;
                 PreparedStatement ftsInsert = ftsAvailable ? connection.prepareStatement(FTS_INSERT_SQL) : null) {
                long rowid = firstRowid;
                for (CallRecord call : calls) {
                    prepared.setLong(1, rowid++);
                    bindPrepared(prepared, call, 1);
                    prepared.addBatch();
                    bindRequest(request, call);
                    request.addBatch();
                    if (call.response() != null || call.error() != null || call.durationMs() != null) {
                        Completion c = new Completion(call.id(), call.response(), call.error(), call.durationMs(),
                                call.interception(), call.reachedUpstream(), call);
                        bindCompleted(completed, c);
                        completed.addBatch();
                        bindResponse(response, c);
                        response.addBatch();
                    }
                }
                prepared.executeBatch();
                request.executeBatch();
                completed.executeBatch();
                response.executeBatch();
                if (ftsAvailable) {
                    for (CallRecord call : calls) {
                        ftsDelete.setString(1, call.id());
                        ftsDelete.addBatch();
                        ftsInsert.setString(1, call.id());
                        ftsInsert.addBatch();
                    }
                    ftsDelete.executeBatch();
                    ftsInsert.executeBatch();
                }
                connection.commit();
            } catch (SQLException e) {
                connection.rollback();
                throw e;
            } finally {
                connection.setAutoCommit(autoCommit);
            }
            return null;
        });
    }

    private void bindPrepared(PreparedStatement ps, CallRecord c) throws SQLException {
        bindPrepared(ps, c, 0);
    }

    /** Binds the prepare columns after {@code shift} leading parameters (the migration's explicit rowid). */
    private void bindPrepared(PreparedStatement ps, CallRecord c, int shift) throws SQLException {
        ps.setString(shift + 1, c.id());
        ps.setString(shift + 2, c.originalUrl());
        ps.setString(shift + 3, c.url());
        ps.setString(shift + 4, c.method());
        ps.setString(shift + 5, c.timestamp());
        setLong(ps, shift + 6, millisOf(c.timestamp()));
        ps.setString(shift + 7, c.sessionId());
        ps.setString(shift + 8, c.operationId());
        ps.setString(shift + 9, c.serviceName());
        ps.setString(shift + 10, CallListSupport.supplierOf(c));
        ps.setString(shift + 11, CallSummary.supplierNameOf(c));
        ps.setString(shift + 12, c.resendOf());
        ps.setString(shift + 13, c.resendEdits() == null ? null : toJson(c.resendEdits()));
        ps.setString(shift + 14, c.relive() == null || c.relive().isNull() ? null : c.relive().toString());
    }

    private void bindRequest(PreparedStatement ps, CallRecord c) throws SQLException {
        ps.setString(1, c.id());
        ps.setString(2, c.request() == null || c.request().headers() == null ? null : toJson(c.request().headers()));
        ps.setString(3, c.request() == null ? null : c.request().body());
    }

    private void bindCompleted(PreparedStatement ps, Completion c) throws SQLException {
        CallRecord k = c.known();
        boolean hasError = c.error() != null && !c.error().isBlank();
        Integer status = c.response() == null ? null : c.response().status();
        ps.setString(1, c.id());
        ps.setString(2, k == null ? null : k.originalUrl());
        ps.setString(3, k == null ? null : k.url());
        ps.setString(4, k == null ? null : k.method());
        ps.setString(5, k == null ? null : k.timestamp());
        setLong(ps, 6, k == null ? null : millisOf(k.timestamp()));
        ps.setString(7, k == null ? null : k.sessionId());
        ps.setString(8, k == null ? null : k.operationId());
        ps.setString(9, k == null ? null : k.serviceName());
        ps.setString(10, k == null ? "unknown" : CallListSupport.supplierOf(k));
        setDouble(ps, 11, c.durationMs());
        setInt(ps, 12, status);
        ps.setInt(13, hasError ? 999 : status == null ? -1 : status);
        ps.setString(14, (hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED).name());
        ps.setString(15, c.error());
        ps.setString(16, c.interception() == null ? null : toJson(c.interception()));
        if (c.reachedUpstream() == null) {
            ps.setNull(17, Types.INTEGER);
        } else {
            ps.setInt(17, c.reachedUpstream() ? 1 : 0);
        }
    }

    private void bindResponse(PreparedStatement ps, Completion c) throws SQLException {
        ps.setString(1, c.id());
        ps.setString(2, c.response() == null || c.response().headers() == null ? null : toJson(c.response().headers()));
        ps.setString(3, c.response() == null ? null : c.response().body());
    }

    // ------------------------------------------------------------------ retention

    public void setRetentionRows(int rows) {
        this.retentionRows = rows;
    }

    int retentionRows() {
        return retentionRows;
    }

    /** After every write: trim when over the count (cheap check), and every N writes check the size. */
    private void afterWrite() {
        boolean checkSize;
        synchronized (this) {
            checkSize = ++writesSinceSizeCheck >= SIZE_CHECK_EVERY_N_WRITES;
            if (checkSize) {
                writesSinceSizeCheck = 0;
            }
        }
        if (count() > retentionRows || (checkSize && usedBytes() > maxSizeBytes)) {
            while (trimOnce() > 0) {
                // each pass is one short transaction of at most MAX_TRIM_BATCH deletes
            }
        }
    }

    /** One retention pass: deletes up to {@link #MAX_TRIM_BATCH} of the oldest calls if over either limit. */
    synchronized int trimOnce() {
        int rows = count();
        int overCount = rows - retentionRows;
        int batch;
        if (overCount > 0) {
            batch = Math.min(overCount, MAX_TRIM_BATCH);
        } else if (rows > 1 && usedBytes() > maxSizeBytes) {
            batch = Math.max(1, Math.min(MAX_TRIM_BATCH, rows / 10));
        } else {
            return 0;
        }
        int deleted = jdbcTemplate.update("DELETE FROM internal_call_metadata WHERE rowid IN "
                + "(SELECT rowid FROM internal_call_metadata ORDER BY rowid LIMIT ?)", batch);
        if (deleted > 0 && overCount <= 0) {
            jdbcTemplate.execute("PRAGMA incremental_vacuum");
        }
        return deleted;
    }

    public int count() {
        Integer n = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM internal_call_metadata", Integer.class);
        return n == null ? 0 : n;
    }

    /** Bytes holding data - page_count minus the freelist (see backend-calls' usedBytes for why not the file size). */
    long usedBytes() {
        Long pages = jdbcTemplate.queryForObject("PRAGMA page_count", Long.class);
        Long free = jdbcTemplate.queryForObject("PRAGMA freelist_count", Long.class);
        Long size = jdbcTemplate.queryForObject("PRAGMA page_size", Long.class);
        return pages == null || free == null || size == null ? 0L : Math.max(0L, pages - free) * size;
    }

    public long storageSizeBytes() {
        return usedBytes();
    }

    public void deleteAll() {
        jdbcTemplate.update("DELETE FROM internal_call_metadata");
        jdbcTemplate.execute("PRAGMA incremental_vacuum");
    }

    public int deleteByReliveRunIds(java.util.Collection<String> runIds) {
        if (runIds == null || runIds.isEmpty()) {
            return 0;
        }
        List<String> ids = new ArrayList<>();
        for (String runId : Set.copyOf(runIds)) {
            ids.addAll(jdbcTemplate.queryForList("SELECT id FROM internal_call_metadata WHERE json_extract(relive_json, '$.runId') = ? "
                    + "OR (relive_json LIKE '%ambiguousRunIds%' AND EXISTS (SELECT 1 FROM json_each(relive_json, '$.ambiguousRunIds') "
                    + "WHERE value = ?))", String.class, runId, runId));
        }
        if (ids.isEmpty()) {
            return 0;
        }
        deletedCallIds.addAll(ids);
        int deleted = 0;
        for (List<String> chunk : chunks(ids, 500)) {
            deleted += jdbcTemplate.update("DELETE FROM internal_call_metadata WHERE id IN (" + placeholders(chunk.size()) + ")",
                    chunk.toArray());
        }
        return deleted;
    }

    // ------------------------------------------------------------------ reads (metadata only unless a body is the answer)

    private static final String SUMMARY_COLUMNS = "m.id, m.original_url, m.url, m.method, m.timestamp, m.duration_ms, m.status, "
            + "m.error, m.supplier_name, m.status_state, m.session_id, m.operation_id, m.service_name, "
            + "json_remove(m.interception, '$.originalRequest.body', '$.originalResponse.body', '$.finalRequest.body', "
            + "'$.finalResponse.body') AS interception, m.resend_of, m.resend_edits, m.relive_json, m.reached_upstream";

    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit,
                                                    boolean paginationEnabled, String sessionId, String operationId,
                                                    String requestId, String serviceNames, String relive) {
        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> args = new ArrayList<>();
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        boolean scan = !query.isEmpty() && (!ftsAvailable || query.length() < 3);
        if (!query.isEmpty() && !scan) {
            where.append(" AND m.rowid IN (SELECT rowid FROM internal_calls_fts WHERE internal_calls_fts MATCH ?)");
            args.add("\"" + query.replace("\"", "\"\"") + "\"");
        } else if (scan) {
            where.append(" AND instr(").append(HAYSTACK_SQL).append(", ?) > 0");
            args.add(query);
        }
        String supplierFilter = supplier == null ? "" : supplier.trim();
        if (!supplierFilter.isEmpty()) {
            where.append(" AND m.supplier = ?");
            args.add(supplierFilter);
        }
        appendFilters(where, args, sessionId, operationId, requestId, serviceNames, relive);
        String from = " FROM internal_call_metadata m" + (scan
                ? " LEFT JOIN internal_call_request q ON q.call_id = m.id LEFT JOIN internal_call_response r ON r.call_id = m.id"
                : "");
        Integer total = jdbcTemplate.queryForObject("SELECT COUNT(*)" + from + where, Integer.class, args.toArray());
        int start = paginationEnabled ? Math.max(0, offset) : 0;
        int size = Math.max(0, Math.min(limit, MAX_ROWS));
        List<Object> pageArgs = new ArrayList<>(args);
        pageArgs.add(size);
        pageArgs.add(start);
        List<CallSummary> items = jdbcTemplate.query("SELECT " + SUMMARY_COLUMNS + from + where + orderBy(sort) + " LIMIT ? OFFSET ?",
                summaryMapper(), pageArgs.toArray());
        return new CallListSupport.Page<>(items, total == null ? 0 : total);
    }

    private static String orderBy(String sort) {
        return switch (sort == null ? "newest" : sort) {
            case "oldest" -> " ORDER BY m.rowid ASC";
            case "oldest-call" -> " ORDER BY coalesce(m.timestamp_millis, 0) ASC, m.rowid ASC";
            case "newest-call" -> " ORDER BY coalesce(m.timestamp_millis, 0) DESC, m.rowid DESC";
            case "slowest" -> " ORDER BY coalesce(m.duration_ms, -1) DESC, m.rowid ASC";
            case "fastest" -> " ORDER BY (m.duration_ms IS NULL) ASC, m.duration_ms ASC, m.rowid ASC";
            case "status" -> " ORDER BY m.status_rank DESC, m.rowid ASC";
            default -> " ORDER BY m.rowid DESC";
        };
    }

    /** Session/operation/request-id substrings, project names (a missing one counts as "unknown") and the Relive filter. */
    private static void appendFilters(StringBuilder where, List<Object> args, String sessionId, String operationId,
                                      String requestId, String serviceNames, String relive) {
        substring(where, args, "m.session_id", sessionId);
        substring(where, args, "m.operation_id", operationId);
        substring(where, args, "m.id", requestId);
        List<String> names = new ArrayList<>();
        if (serviceNames != null) {
            for (String name : serviceNames.split(",")) {
                if (!name.strip().isEmpty()) {
                    names.add(name.strip());
                }
            }
        }
        if (!names.isEmpty()) {
            where.append(" AND coalesce(m.service_name, 'unknown') IN (").append(placeholders(names.size())).append(")");
            args.addAll(names);
        }
        if (!ReliveFilter.isBlank(relive)) {
            String filter = relive.trim();
            String tagged = "(m.relive_json IS NOT NULL AND m.relive_json NOT IN ('null', '{}'))";
            if (ReliveFilter.EXCLUDE.equals(filter)) {
                where.append(" AND NOT ").append(tagged);
            } else {
                where.append(" AND ").append(tagged).append(" AND (json_extract(m.relive_json, '$.runId') = ? OR EXISTS ")
                        .append("(SELECT 1 FROM json_each(m.relive_json, '$.ambiguousRunIds') WHERE value = ?))");
                args.add(filter);
                args.add(filter);
            }
        }
    }

    private static void substring(StringBuilder where, List<Object> args, String column, String filter) {
        if (filter != null && !filter.isBlank()) {
            where.append(" AND instr(lower(coalesce(").append(column).append(", '')), ?) > 0");
            args.add(filter.toLowerCase(Locale.ROOT));
        }
    }

    public Optional<CallRecord> findById(String id) {
        List<CallRecord> found = jdbcTemplate.query("SELECT " + RECORD_COLUMNS + RECORD_FROM + " WHERE m.id = ?", recordMapper(true), id);
        return found.stream().findFirst();
    }

    private static final String RECORD_COLUMNS = "m.id, m.original_url, m.url, m.method, m.timestamp, m.duration_ms, m.status, "
            + "m.error, m.status_state, m.session_id, m.operation_id, m.service_name, m.interception, m.resend_of, m.resend_edits, "
            + "m.relive_json, m.reached_upstream, q.headers AS q_headers, q.body AS q_body, r.headers AS r_headers, r.body AS r_body, "
            + "(q.call_id IS NOT NULL) AS has_request, (r.call_id IS NOT NULL) AS has_response";
    private static final String RECORD_FROM = " FROM internal_call_metadata m LEFT JOIN internal_call_request q ON q.call_id = m.id"
            + " LEFT JOIN internal_call_response r ON r.call_id = m.id";

    public List<CallRecord> findByReliveRunId(String runId) {
        return jdbcTemplate.query("SELECT " + RECORD_COLUMNS + RECORD_FROM + " WHERE json_extract(m.relive_json, '$.runId') = ? "
                + "OR (m.relive_json LIKE '%ambiguousRunIds%' AND EXISTS (SELECT 1 FROM json_each(m.relive_json, '$.ambiguousRunIds') "
                + "WHERE value = ?)) ORDER BY m.rowid LIMIT " + MAX_ROWS, recordMapper(true), runId, runId);
    }

    /** Resolved calls in a time window, metadata only: status kept, bodies null - callers read bodies per call via detail. */
    public List<CallRecord> findResolvedInRange(Instant from, Instant to, String search, String sessionId, String operationId,
                                                String requestId, String serviceNames) {
        StringBuilder where = new StringBuilder(" WHERE m.status_state <> 'IN_PROGRESS' AND coalesce(m.timestamp_millis, 0) BETWEEN ? AND ?");
        List<Object> args = new ArrayList<>(List.of(from.toEpochMilli(), to.toEpochMilli()));
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        boolean scan = !query.isEmpty() && (!ftsAvailable || query.length() < 3);
        if (!query.isEmpty() && !scan) {
            where.append(" AND m.rowid IN (SELECT rowid FROM internal_calls_fts WHERE internal_calls_fts MATCH ?)");
            args.add("\"" + query.replace("\"", "\"\"") + "\"");
        } else if (scan) {
            where.append(" AND instr(").append(HAYSTACK_SQL).append(", ?) > 0");
            args.add(query);
        }
        appendFilters(where, args, sessionId, operationId, requestId, serviceNames, "");
        String fromSql = " FROM internal_call_metadata m" + (scan
                ? " LEFT JOIN internal_call_request q ON q.call_id = m.id LEFT JOIN internal_call_response r ON r.call_id = m.id" : "");
        return jdbcTemplate.query("SELECT m.id, m.original_url, m.url, m.method, m.timestamp, m.duration_ms, m.status, m.error, "
                + "m.status_state, m.session_id, m.operation_id, m.service_name, NULL AS interception, m.resend_of, m.resend_edits, "
                + "m.relive_json, m.reached_upstream, NULL AS q_headers, NULL AS q_body, NULL AS r_headers, NULL AS r_body, "
                + "0 AS has_request, (m.status IS NOT NULL) AS has_response" + fromSql + where + " ORDER BY m.rowid LIMIT " + MAX_ROWS,
                recordMapper(false), args.toArray());
    }

    /** Newest-first request headers of calls to {@code host} (no bodies), for the resend value lookup. */
    public List<RecentRequestHeaders> recentRequestHeaders(String host, int limit) {
        List<RecentRequestHeaders> out = new ArrayList<>();
        int cap = Math.max(0, limit);
        // The host is matched exactly in Java (URI host, case-insensitive); the LIKE only narrows the scan.
        jdbcTemplate.query("SELECT m.id, m.url, q.headers FROM internal_call_metadata m JOIN internal_call_request q ON q.call_id = m.id "
                + "WHERE instr(lower(coalesce(m.url, '')), ?) > 0 ORDER BY m.rowid DESC LIMIT " + MAX_ROWS, rs -> {
            if (out.size() < cap && hostMatches(rs.getString("url"), host)) {
                out.add(new RecentRequestHeaders(rs.getString("id"), headers(rs.getString("headers"))));
            }
        }, host == null ? "" : host.toLowerCase(Locale.ROOT));
        return out;
    }

    private static boolean hostMatches(String url, String host) {
        if (url == null || host == null) {
            return false;
        }
        try {
            return host.equalsIgnoreCase(java.net.URI.create(url).getHost());
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    public CallBaseline baselineFor(String url) {
        List<Double> durations = jdbcTemplate.queryForList("SELECT duration_ms FROM internal_call_metadata WHERE url = ? "
                + "AND status_state <> 'IN_PROGRESS' AND duration_ms IS NOT NULL ORDER BY duration_ms LIMIT " + MAX_ROWS, Double.class, url);
        if (durations.isEmpty()) {
            return CallBaseline.empty(url);
        }
        return new CallBaseline(url, durations.size(), at(durations, 0.50), at(durations, 0.95));
    }

    private static Double at(List<Double> sorted, double percentile) {
        int index = Math.min(sorted.size() - 1, Math.max(0, (int) Math.floor(sorted.size() * percentile)));
        return sorted.get(index);
    }

    public CallStatusBreakdown statusBreakdown() {
        return jdbcTemplate.queryForObject("""
                SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status_state <> 'IN_PROGRESS' AND (error IS NULL OR error = '') AND status BETWEEN 200 AND 399 THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN status_state <> 'IN_PROGRESS' AND (error IS NULL OR error = '') AND status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS client_error,
                  SUM(CASE WHEN status_state <> 'IN_PROGRESS' AND ((error IS NOT NULL AND error <> '') OR status >= 500) THEN 1 ELSE 0 END) AS server_error,
                  SUM(CASE WHEN status_state = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress
                FROM internal_call_metadata""", (rs, n) -> new CallStatusBreakdown(rs.getLong("total"), rs.getLong("ok"),
                rs.getLong("client_error"), rs.getLong("server_error"), rs.getLong("in_progress")));
    }

    /** Kept for the port contract only - reads every body ever stored. No request path may call it. */
    public List<CallRecord> readAll() {
        return jdbcTemplate.query("SELECT " + RECORD_COLUMNS + RECORD_FROM + " ORDER BY m.rowid", recordMapper(true));
    }

    // ------------------------------------------------------------------ WebSocket messages

    public void appendWsMessages(String callId, List<WsMessage> messages) {
        if (messages.isEmpty() || single("SELECT 1 FROM internal_call_metadata WHERE id = ?", Integer.class, callId) == null) {
            return; // a call retention already removed (or never stored) - dropped, as the file store does
        }
        jdbcTemplate.batchUpdate("INSERT OR REPLACE INTO internal_call_ws_message (call_id, seq, direction, ts_millis, type, content, "
                + "content_base64, original_content, action) VALUES (?,?,?,?,?,?,?,?,?)", messages, messages.size(), (ps, m) -> {
            ps.setString(1, callId);
            ps.setInt(2, m.seq());
            ps.setString(3, m.direction());
            ps.setLong(4, m.tsMillis());
            ps.setString(5, m.type());
            ps.setString(6, m.content());
            ps.setString(7, m.contentBase64());
            ps.setString(8, m.originalContent());
            ps.setString(9, m.action());
        });
        Integer total = single("SELECT COUNT(*) FROM internal_call_ws_message WHERE call_id = ?", Integer.class, callId);
        int overflow = (total == null ? 0 : total) - wsMaxMessages;
        if (overflow > 0) {
            jdbcTemplate.update("DELETE FROM internal_call_ws_message WHERE call_id = ? AND seq IN "
                    + "(SELECT seq FROM internal_call_ws_message WHERE call_id = ? ORDER BY seq LIMIT ?)", callId, callId, overflow);
            jdbcTemplate.update("UPDATE internal_call_metadata SET ws_dropped = ws_dropped + ? WHERE id = ?", overflow, callId);
        }
    }

    public WsMessagesPage wsMessages(String callId, int offset, int limit) {
        Integer total = single("SELECT COUNT(*) FROM internal_call_ws_message WHERE call_id = ?", Integer.class, callId);
        Integer dropped = single("SELECT ws_dropped FROM internal_call_metadata WHERE id = ?", Integer.class, callId);
        List<WsMessage> page = jdbcTemplate.query("SELECT seq, direction, ts_millis, type, content, content_base64, original_content, action "
                + "FROM internal_call_ws_message WHERE call_id = ? ORDER BY seq LIMIT ? OFFSET ?", (rs, n) -> new WsMessage(
                rs.getInt("seq"), rs.getString("direction"), rs.getLong("ts_millis"), rs.getString("type"), rs.getString("content"),
                rs.getString("content_base64"), rs.getString("original_content"), rs.getString("action")),
                callId, Math.max(0, Math.min(limit, MAX_ROWS)), Math.max(0, offset));
        return new WsMessagesPage(page, total == null ? 0 : total, dropped == null ? 0 : dropped);
    }

    // ------------------------------------------------------------------ mapping

    private RowMapper<CallSummary> summaryMapper() {
        return (rs, n) -> new CallSummary(rs.getString("id"), rs.getString("original_url"), rs.getString("url"), rs.getString("method"),
                rs.getString("timestamp"), doubleOrNull(rs, "duration_ms"), intOrNull(rs, "status"), rs.getString("error"),
                rs.getString("supplier_name"), CallLifecycleStatus.valueOf(rs.getString("status_state")), rs.getString("session_id"),
                rs.getString("operation_id"), rs.getString("service_name"), interception(rs.getString("interception")),
                rs.getString("resend_of"), json(rs.getString("resend_edits")), json(rs.getString("relive_json")),
                booleanOrNull(rs, "reached_upstream"));
    }

    private RowMapper<CallRecord> recordMapper(boolean withBodies) {
        return (rs, n) -> {
            Integer status = intOrNull(rs, "status");
            RequestData request = rs.getBoolean("has_request")
                    ? new RequestData(headers(rs.getString("q_headers")), rs.getString("q_body")) : null;
            ResponseData response = withBodies
                    ? (rs.getBoolean("has_response") && (status != null || rs.getString("r_body") != null || rs.getString("r_headers") != null)
                    ? new ResponseData(status, headers(rs.getString("r_headers")), rs.getString("r_body")) : null)
                    : (status == null ? null : new ResponseData(status, null, null));
            return new CallRecord(rs.getString("id"), rs.getString("original_url"), rs.getString("url"), rs.getString("method"),
                    request, rs.getString("timestamp"), doubleOrNull(rs, "duration_ms"), response, rs.getString("error"),
                    CallLifecycleStatus.valueOf(rs.getString("status_state")), rs.getString("session_id"), rs.getString("operation_id"),
                    rs.getString("service_name"), interception(rs.getString("interception")), rs.getString("resend_of"),
                    json(rs.getString("resend_edits")), json(rs.getString("relive_json")), booleanOrNull(rs, "reached_upstream"));
        };
    }

    private Map<String, String> headers(String json) {
        if (json == null) {
            return null;
        }
        try {
            return objectMapper.readValue(json, new TypeReference<LinkedHashMap<String, String>>() { });
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private CallInterception interception(String json) {
        if (json == null) {
            return null;
        }
        try {
            return objectMapper.readValue(json, CallInterception.class);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private JsonNode json(String text) {
        if (text == null) {
            return null;
        }
        try {
            return objectMapper.readTree(text);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Could not serialize " + value.getClass().getSimpleName(), e);
        }
    }

    private <T> T single(String sql, Class<T> type, Object... args) {
        List<T> rows = jdbcTemplate.queryForList(sql, type, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Same parsing as CallListSupport.callTimeMillis; null (not 0) when unknown, so a completion can fill it in later. */
    static Long millisOf(String ts) {
        if (ts == null || ts.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(ts).toEpochMilli();
        } catch (DateTimeParseException e) {
            try {
                return OffsetDateTime.parse(ts).toInstant().toEpochMilli();
            } catch (DateTimeParseException e2) {
                return null;
            }
        }
    }

    private static Double doubleOrNull(ResultSet rs, String column) throws SQLException {
        double v = rs.getDouble(column);
        return rs.wasNull() ? null : v;
    }

    private static Integer intOrNull(ResultSet rs, String column) throws SQLException {
        int v = rs.getInt(column);
        return rs.wasNull() ? null : v;
    }

    private static Boolean booleanOrNull(ResultSet rs, String column) throws SQLException {
        int v = rs.getInt(column);
        return rs.wasNull() ? null : v != 0;
    }

    private static void setLong(PreparedStatement ps, int index, Long value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.INTEGER);
        } else {
            ps.setLong(index, value);
        }
    }

    private static void setInt(PreparedStatement ps, int index, Integer value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.INTEGER);
        } else {
            ps.setInt(index, value);
        }
    }

    private static void setDouble(PreparedStatement ps, int index, Double value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.REAL);
        } else {
            ps.setDouble(index, value);
        }
    }

    private static String placeholders(int n) {
        return String.join(",", Collections.nCopies(n, "?"));
    }

    private static <T> List<List<T>> chunks(List<T> list, int size) {
        List<List<T>> out = new ArrayList<>();
        for (int i = 0; i < list.size(); i += size) {
            out.add(list.subList(i, Math.min(list.size(), i + size)));
        }
        return out;
    }
}
