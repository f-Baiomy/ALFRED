package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallBaseline;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallInterception;
import com.fathy.alfred.backend.calls.domain.model.CallTiming;
import com.fathy.alfred.backend.calls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Owns every raw SQL/JDBC detail for {@code calls.db} - schema, pragmas, inserts, the
 * search/sort/pagination query, and size-based retention. {@link SqliteCallLogAdapter} is a thin
 * wrapper that implements {@code CallLogPort} purely by delegating here, so swapping to a
 * different engine later means writing one new repository class, not touching CallsService or
 * the port interface (see the Repository-pattern note in the migration plan).
 *
 * <p>Storage is split across three tables rather than one wide row: {@code call_metadata} (every
 * column {@link #query}/{@link #statusBreakdown}/retention ever touch - list/search/sort/
 * pagination never read a byte of request/response payload), {@code call_request}, and
 * {@code call_response} (one row each, linked by {@code call_id}, holding only headers/body).
 * Both payload tables get a row the moment a call is {@link #save saved}/{@link #prepare}d -
 * blank (null headers/body) for an in-progress call, filled in immediately for an
 * already-resolved one - and {@link #complete} then just {@code UPDATE}s the existing
 * {@code call_response} row rather than inserting a new one. {@code ON DELETE CASCADE} (with
 * {@code PRAGMA foreign_keys=ON}, see the connection init SQL below) means retention/deleteAll
 * only ever needs to delete from {@code call_metadata} - the payload tables clean up on their own.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.calls", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteCallsRepository {

    private static final Logger log = LoggerFactory.getLogger(SqliteCallsRepository.class);

    /** What {@code PRAGMA auto_vacuum} returns for INCREMENTAL (0 = NONE, 1 = FULL, 2 = INCREMENTAL). */
    private static final int AUTO_VACUUM_INCREMENTAL = 2;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${CALLS_DB_FILE:/appdata/calls.db}")
    private String dbFile;

    /** Once the on-disk file exceeds this, the oldest rows are dropped until back under it - the actual mechanism behind the "up to 100GB" retention target. Override via ALFRED_CALLS_MAX_SIZE_BYTES. */
    @Value("${alfred.storage.calls.max-size-bytes:107374182400}")
    private long maxSizeBytes;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbcTemplate;
    private volatile boolean ftsAvailable;
    private BatchWriter<CallRecord> insertWriter;
    private BatchWriter<PendingCompletion> completionWriter;

    /** How often (in saves) to check the file size against maxSizeBytes - stat'ing the file on every single insert would itself be wasteful at high write volume. */
    private static final int SIZE_CHECK_EVERY_N_SAVES = 50;

    /** Most calls one retention pass will delete, however far over the target the database is. */
    private static final int MAX_DELETE_BATCH = 1000;

    /**
     * Retention never trims below this many calls. A database has a fixed overhead - schema plus
     * the FTS index, measured at ~4MB on an otherwise empty test database - that deleting rows
     * cannot reclaim, so a target smaller than that overhead is unreachable no matter how much is
     * deleted. Without this floor, such a target means "delete everything and still be over".
     */
    private static final int MIN_RETAINED_CALLS = 50;
    private int savesSinceLastSizeCheck;

    /** The outcome half of a two-phase call, awaiting write via {@link #completionWriter} - see {@link #complete}. */
    private record PendingCompletion(String id, ResponseData response, String error, Double durationMs, CallTiming timing, CallInterception interception) {}

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
        // journal_mode/synchronous/busy_timeout/foreign_keys are per-CONNECTION settings in
        // SQLite, not persisted in the database file - they need to apply to every physical
        // connection Hikari opens, not just whichever one happens to run a one-off
        // jdbcTemplate.execute() at startup. A semicolon-joined connectionInitSql string looks like
        // the natural way to do that, but this JDBC driver only reliably executes the *first*
        // statement in a compound string via connectionInitSql (verified empirically - busy_timeout
        // silently stayed at the driver's own 3000ms default, synchronous stayed FULL, foreign_keys
        // stayed off, no matter what came after the first pragma). The sqlite-jdbc driver's own URL
        // query-parameter syntax applies all of them correctly on every connection instead, so pass
        // them there rather than via connectionInitSql. A 10s busy_timeout means a second concurrent
        // writer waits for the first to finish instead of failing outright, and foreign_keys=true is
        // what makes retention/deleteAll's cascade-delete of call_request/call_response actually happen.
        config.setJdbcUrl("jdbc:sqlite:" + path + "?journal_mode=WAL&synchronous=NORMAL&busy_timeout=10000&foreign_keys=true");
        config.setMaximumPoolSize(20);
        config.setPoolName("calls-sqlite-pool");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        ensureIncrementalAutoVacuum();

        createSchema();
        initFts();

        // Group-commit writer: exactly one thread ever opens a write transaction against
        // calls.db, so concurrent webhook calls never contend for SQLite's single write lock with
        // each other, and a burst that arrives while a commit is in flight gets folded into the
        // next transaction instead of each paying for its own commit. See BatchWriter's own doc.
        // Queue capacity of 1000 comfortably exceeds Tomcat's default max worker threads (200) -
        // see BatchWriter's queueCapacity doc for why that's the number that actually matters.
        //
        // Statement order matters here: call_metadata must be inserted before call_request/
        // call_response (both FK-reference it), and BatchWriter runs one statement across the
        // whole batch before moving to the next - so every item's metadata row lands before any
        // item's payload rows, satisfying the FK regardless of batch size.
        this.insertWriter = new BatchWriter<>("calls-sqlite-writer", dataSource, List.of(
                new BatchWriter.StatementSpec<>(INSERT_METADATA_SQL, this::bindMetadata),
                new BatchWriter.StatementSpec<>(INSERT_REQUEST_SQL, this::bindRequest),
                new BatchWriter.StatementSpec<>(INSERT_RESPONSE_SQL, this::bindResponseFromCall)
        ), 1000);
        // A second, independent writer for the two-phase "complete" UPDATEs - same rationale as
        // insertWriter (one dedicated thread, no cross-request lock contention), but a distinct
        // instance since BatchWriter is bound to one fixed set of statements/binders. SQLite only
        // ever allows one writer at a time regardless (WAL mode + busy_timeout already serializes
        // the two threads against each other exactly like it does for concurrent inserts today).
        this.completionWriter = new BatchWriter<>("calls-sqlite-completion-writer", dataSource, List.of(
                new BatchWriter.StatementSpec<>(UPDATE_METADATA_SQL, this::bindCompletionMetadata),
                new BatchWriter.StatementSpec<>(UPDATE_RESPONSE_SQL, this::bindCompletionResponse)
        ), 1000);

        migrateLegacySingleTableIfPresent();
    }

    /**
     * Makes auto_vacuum actually be INCREMENTAL, converting the file if it isn't already.
     *
     * <p>{@code PRAGMA auto_vacuum} only takes effect on a database with no schema yet. On an
     * existing file SQLite accepts the statement and silently keeps the old mode - so every
     * deployment created before that pragma was added still reports NONE (confirmed on live data:
     * a 30MB calls.db reporting auto_vacuum=0 despite this code running on every boot). With NONE,
     * deleted pages go to the freelist and <b>the file never shrinks</b>, which makes
     * {@code PRAGMA incremental_vacuum} a no-op and left {@link #enforceRetention()} with a size
     * condition it could never satisfy - it deleted every call in the table instead of the oldest
     * few (measured: deleting 90% of rows changed the file size by 0 bytes).
     *
     * <p>Converting requires a full VACUUM, which rewrites the file end to end - cheap on a small
     * database, very expensive on a large one, which is exactly why it's worth doing at the first
     * opportunity rather than when retention finally fires. Both statements must run on the SAME
     * physical connection (the pragma is per-connection state that VACUUM reads), so this takes a
     * connection explicitly rather than issuing two pooled jdbcTemplate calls.
     */
    private void ensureIncrementalAutoVacuum() {
        Integer mode = jdbcTemplate.execute((ConnectionCallback<Integer>) connection -> {
            try (Statement statement = connection.createStatement()) {
                statement.execute("PRAGMA auto_vacuum=INCREMENTAL");
                try (ResultSet rs = statement.executeQuery("PRAGMA auto_vacuum")) {
                    int current = rs.next() ? rs.getInt(1) : -1;
                    if (current == AUTO_VACUUM_INCREMENTAL) {
                        return current;
                    }
                    log.info("calls.db reports auto_vacuum={} - converting to INCREMENTAL with a one-time VACUUM "
                            + "so retention can reclaim space instead of emptying the table", current);
                    statement.execute("VACUUM");
                }
                try (ResultSet rs = statement.executeQuery("PRAGMA auto_vacuum")) {
                    return rs.next() ? rs.getInt(1) : -1;
                }
            }
        });
        if (mode == null || mode != AUTO_VACUUM_INCREMENTAL) {
            log.error("calls.db still reports auto_vacuum={} after conversion - retention cannot shrink the file, "
                    + "so it will refuse to trim rather than delete everything", mode);
        }
    }

    private void createSchema() {
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS call_metadata (
                  id TEXT PRIMARY KEY,
                  original_url TEXT,
                  url TEXT,
                  method TEXT,
                  timestamp TEXT,
                  timestamp_millis INTEGER,
                  duration_ms REAL,
                  status INTEGER,
                  status_rank INTEGER,
                  supplier TEXT,
                  supplier_name TEXT,
                  error TEXT,
                  haystack TEXT,
                  status_state TEXT NOT NULL DEFAULT 'COMPLETED',
                  request_haystack TEXT,
                  session_id TEXT,
                  operation_id TEXT,
                  service_name TEXT
                )
                """);
        addSessionOperationColumnsIfMissing();
        addServiceNameColumnIfMissing();
        addTimingColumnsIfMissing();
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS call_request (
                  call_id TEXT PRIMARY KEY REFERENCES call_metadata(id) ON DELETE CASCADE,
                  headers TEXT,
                  body TEXT
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS call_response (
                  call_id TEXT PRIMARY KEY REFERENCES call_metadata(id) ON DELETE CASCADE,
                  headers TEXT,
                  body TEXT
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_call_metadata_timestamp_millis ON call_metadata(timestamp_millis)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_call_metadata_supplier ON call_metadata(supplier)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_call_metadata_status_rank ON call_metadata(status_rank)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_call_metadata_duration ON call_metadata(duration_ms)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_call_metadata_status_state ON call_metadata(status_state)");
    }

    /** {@code session_id}/{@code operation_id} were added after call_metadata was already in use in some deployments (this repository already existed with 3 tables before these two fields) - added explicitly via ALTER TABLE for those, same pattern as every other column added after initial rollout. */
    private void addSessionOperationColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(call_metadata)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("session_id")) {
            jdbcTemplate.execute("ALTER TABLE call_metadata ADD COLUMN session_id TEXT");
        }
        if (!columns.contains("operation_id")) {
            jdbcTemplate.execute("ALTER TABLE call_metadata ADD COLUMN operation_id TEXT");
        }
    }

    /** The four phase timings postdate every other column - added the same ALTER TABLE way, and nullable because a call logged before the proxy reported them has no measurement (never zero). */
    private void addTimingColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(call_metadata)", (rs, rowNum) -> rs.getString("name"));
        for (String column : List.of("connect_ms", "tls_ms", "ttfb_ms", "download_ms")) {
            if (!columns.contains(column)) {
                jdbcTemplate.execute("ALTER TABLE call_metadata ADD COLUMN " + column + " REAL");
            }
        }
        if (!columns.contains("reused_connection")) {
            jdbcTemplate.execute("ALTER TABLE call_metadata ADD COLUMN reused_connection INTEGER");
        }
        // One JSON column rather than a table: an interception record is a variable-length
        // document that is only ever read back whole with its call, and nothing queries into it.
        // Nullable because almost every call has none.
        if (!columns.contains("interception")) {
            jdbcTemplate.execute("ALTER TABLE call_metadata ADD COLUMN interception TEXT");
        }
    }

    /** {@code service_name} postdates even session_id/operation_id - added explicitly via ALTER TABLE for a database created before this field existed, same pattern as {@link #addSessionOperationColumnsIfMissing}. */
    private void addServiceNameColumnIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(call_metadata)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("service_name")) {
            jdbcTemplate.execute("ALTER TABLE call_metadata ADD COLUMN service_name TEXT");
        }
    }

    /** FTS5 with the trigram tokenizer mirrors CallListSupport.matchesSearch's `.contains(query)` substring semantics far more closely than the default whole-token tokenizer. Falls back to a plain `LIKE` scan over the haystack column if this SQLite build lacks FTS5/trigram, rather than failing startup. */
    private void initFts() {
        try {
            jdbcTemplate.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS calls_fts USING fts5(
                      haystack, content='call_metadata', content_rowid='rowid', tokenize='trigram'
                    )
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS call_metadata_ai AFTER INSERT ON call_metadata BEGIN
                      INSERT INTO calls_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS call_metadata_ad AFTER DELETE ON call_metadata BEGIN
                      INSERT INTO calls_fts(calls_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS call_metadata_au AFTER UPDATE ON call_metadata BEGIN
                      INSERT INTO calls_fts(calls_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
                      INSERT INTO calls_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
                    END
                    """);
            ftsAvailable = true;
        } catch (Exception e) {
            ftsAvailable = false;
            log.warn("FTS5 trigram virtual table unavailable, falling back to LIKE-based search: {}", e.getMessage());
        }
    }

    /**
     * One-time, safely-rerunnable migration from the pre-split single {@code calls} table (every
     * column in one row) into the new {@code call_metadata}/{@code call_request}/
     * {@code call_response} shape - skipped if {@code calls} doesn't exist (a fresh install), or if
     * {@code call_metadata} already has rows (covers both "already migrated" and "started fresh on
     * the 3-table schema"). Normalizes the legacy table's own shape first (the same
     * supplier_name/lifecycle-column backfills this repository always used to do against it),
     * reads it back via the exact old row shape, and re-persists each row through {@link #save} -
     * the same public write path live traffic uses, so the new tables end up byte-for-byte
     * equivalent to a call that arrived after the split. The legacy table is renamed (never
     * dropped) to {@code calls_legacy} afterward, kept as a safety-net backup.
     */
    private void migrateLegacySingleTableIfPresent() {
        boolean legacyTableExists = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'calls'", Integer.class) > 0;
        if (!legacyTableExists || count() > 0) {
            return;
        }

        addLegacySupplierNameColumnIfMissing();
        addLegacyLifecycleColumnsIfMissing();
        addLegacySessionOperationColumnsIfMissing();

        int migrated = 0;
        List<CallRecord> legacyRows = jdbcTemplate.query("SELECT * FROM calls ORDER BY rowid ASC", LEGACY_ROW_MAPPER);
        for (CallRecord call : legacyRows) {
            save(call);
            migrated++;
        }

        jdbcTemplate.execute("ALTER TABLE calls RENAME TO calls_legacy");
        log.info("Migrated {} call(s) from the legacy single-table calls.db shape into call_metadata/call_request/call_response; renamed calls to calls_legacy", migrated);
    }

    private void addLegacySupplierNameColumnIfMissing() {
        boolean alreadyPresent = jdbcTemplate.query("PRAGMA table_info(calls)",
                        (rs, rowNum) -> rs.getString("name"))
                .stream().anyMatch("supplier_name"::equals);
        if (!alreadyPresent) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN supplier_name TEXT");
        }
    }

    private void addLegacyLifecycleColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(calls)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("status_state")) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN status_state TEXT NOT NULL DEFAULT 'COMPLETED'");
            jdbcTemplate.update("UPDATE calls SET status_state = 'ERROR' WHERE error IS NOT NULL AND error != ''");
        }
        if (!columns.contains("request_haystack")) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN request_haystack TEXT");
        }
    }

    /** session_id/operation_id postdate even the single-table {@code calls} schema - an ancient never-migrated database has neither, so LEGACY_ROW_MAPPER's {@code SELECT *} needs them added (as NULL) before it can read the row. */
    private void addLegacySessionOperationColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(calls)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("session_id")) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN session_id TEXT");
        }
        if (!columns.contains("operation_id")) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN operation_id TEXT");
        }
    }

    @PreDestroy
    public void close() {
        if (insertWriter != null) {
            insertWriter.close();
        }
        if (completionWriter != null) {
            completionWriter.close();
        }
        if (dataSource != null) {
            try {
                // Merges -wal/-shm back into the main file and drops them, rather than leaving
                // WAL-mode's auxiliary files behind for the OS to release on its own schedule -
                // matters most for tests on Windows, where a lingering handle on those files can
                // make @TempDir cleanup fail right after this method returns.
                jdbcTemplate.execute("PRAGMA wal_checkpoint(TRUNCATE)");
            } catch (Exception ignored) {
                // Best-effort - the pool is closing either way.
            }
            dataSource.close();
        }
    }

    /** Blocks until the call is actually committed (all 3 tables) - see BatchWriter's class doc for why this is still synchronous (and safe under concurrency) despite writes now being batched. Used both for a fully-resolved call (the legacy single-shot webhook, or a migrated legacy row) and for the first half of two-phase logging (state IN_PROGRESS, response/error/durationMs null) - the binders already handle either shape. */
    public void save(CallRecord call) {
        insertWriter.submit(call);

        if (++savesSinceLastSizeCheck >= SIZE_CHECK_EVERY_N_SAVES) {
            savesSinceLastSizeCheck = 0;
            enforceRetention();
        }
    }

    private static final String INSERT_METADATA_SQL = """
            INSERT INTO call_metadata (id, original_url, url, method, timestamp, timestamp_millis, duration_ms,
                               status, status_rank, supplier, supplier_name, error, haystack, status_state, request_haystack,
                               session_id, operation_id, service_name)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """;

    private static final String INSERT_REQUEST_SQL = "INSERT INTO call_request (call_id, headers, body) VALUES (?,?,?)";

    private static final String INSERT_RESPONSE_SQL = "INSERT INTO call_response (call_id, headers, body) VALUES (?,?,?)";

    /** Binds one call's metadata-table columns - runs on insertWriter's single dedicated thread. */
    private void bindMetadata(PreparedStatement ps, CallRecord call) throws SQLException {
        CallRecord normalized = CallRecord.withDerivedStateIfMissing(call);
        String requestHaystack = buildRequestHaystack(normalized);
        String haystack = buildHaystack(normalized, requestHaystack);
        Integer status = normalized.response() != null ? normalized.response().status() : null;
        ps.setString(1, normalized.id());
        ps.setString(2, normalized.originalUrl());
        ps.setString(3, normalized.url());
        ps.setString(4, normalized.method());
        ps.setString(5, normalized.timestamp());
        ps.setLong(6, callTimeMillis(normalized));
        if (normalized.durationMs() != null) {
            ps.setDouble(7, normalized.durationMs());
        } else {
            ps.setNull(7, Types.DOUBLE);
        }
        if (status != null) {
            ps.setInt(8, status);
        } else {
            ps.setNull(8, Types.INTEGER);
        }
        ps.setInt(9, statusRank(normalized.response(), normalized.error()));
        ps.setString(10, CallListSupport.supplierOf(normalized));
        // Precomputed here (not derived from request_body on every read) so list/search queries
        // can skip fetching request_body entirely - see query()'s SUMMARY_SQL. Stored as "" rather
        // than SQL NULL when there's genuinely no supplier field, for consistency with how this
        // value has always round-tripped (see nullIfEmpty).
        String supplierName = CallSummary.supplierNameOf(normalized);
        ps.setString(11, supplierName == null ? "" : supplierName);
        ps.setString(12, normalized.error());
        ps.setString(13, haystack);
        ps.setString(14, normalized.state().name());
        ps.setString(15, requestHaystack);
        ps.setString(16, normalized.sessionId());
        ps.setString(17, normalized.operationId());
        ps.setString(18, normalized.serviceName());
    }

    /** Binds one call's request-table row - always inserted (headers/body null if there is no request data). */
    private void bindRequest(PreparedStatement ps, CallRecord call) throws SQLException {
        RequestData request = call.request();
        ps.setString(1, call.id());
        ps.setString(2, toJson(request != null ? request.headers() : null));
        ps.setString(3, request != null ? request.body() : null);
    }

    /** Binds one call's response-table row at insert time - null headers/body for a still-in-progress call (filled in later by {@link #complete}), already-populated for a call that arrived already resolved (the legacy single-shot webhook, or a migrated legacy row). */
    private void bindResponseFromCall(PreparedStatement ps, CallRecord call) throws SQLException {
        ResponseData response = call.response();
        ps.setString(1, call.id());
        ps.setString(2, toJson(response != null ? response.headers() : null));
        ps.setString(3, response != null ? response.body() : null);
    }

    private static final String UPDATE_METADATA_SQL = """
            UPDATE call_metadata SET
              status = ?, status_rank = ?, error = ?, duration_ms = ?, status_state = ?,
              connect_ms = ?, tls_ms = ?, ttfb_ms = ?, download_ms = ?, reused_connection = ?,
              interception = ?,
              haystack = substr(COALESCE(request_haystack, '') || ' ' || ?, 1, ?)
            WHERE id = ?
            """;

    private static final String UPDATE_RESPONSE_SQL = "UPDATE call_response SET headers = ?, body = ? WHERE call_id = ?";

    /** Second half of two-phase logging - fills in a previously-{@link #save prepared} call's outcome. @return true if a row with this id existed to update. */
    public boolean complete(String id, ResponseData response, String error, Double durationMs, CallTiming timing, CallInterception interception) {
        Integer existing = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM call_metadata WHERE id = ?", Integer.class, id);
        if (existing == null || existing == 0) {
            return false;
        }
        completionWriter.submit(new PendingCompletion(id, response, error, durationMs, timing, interception));
        return true;
    }

    private void bindCompletionMetadata(PreparedStatement ps, PendingCompletion pending) throws SQLException {
        ResponseData response = pending.response();
        String error = pending.error();
        boolean hasError = error != null && !error.isBlank();
        CallLifecycleStatus state = hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED;
        Integer status = response != null ? response.status() : null;

        if (status != null) {
            ps.setInt(1, status);
        } else {
            ps.setNull(1, Types.INTEGER);
        }
        ps.setInt(2, statusRank(response, error));
        ps.setString(3, error);
        if (pending.durationMs() != null) {
            ps.setDouble(4, pending.durationMs());
        } else {
            ps.setNull(4, Types.DOUBLE);
        }
        ps.setString(5, state.name());

        // Every phase timing is independently nullable - see CallTiming. A reused connection has no
        // connect/TLS time of its own to report, and a call logged before the proxy measured any of
        // this has none at all, so writing 0 would be a measurement that never happened.
        CallTiming timing = pending.timing();
        setNullableDouble(ps, 6, timing != null ? timing.connectMs() : null);
        setNullableDouble(ps, 7, timing != null ? timing.tlsMs() : null);
        setNullableDouble(ps, 8, timing != null ? timing.ttfbMs() : null);
        setNullableDouble(ps, 9, timing != null ? timing.downloadMs() : null);
        if (timing != null && timing.reusedConnection() != null) {
            ps.setInt(10, timing.reusedConnection() ? 1 : 0);
        } else {
            ps.setNull(10, Types.INTEGER);
        }

        ps.setString(11, writeInterception(pending.interception()));

        ps.setString(12, buildResponseHaystackFragment(response, error));
        ps.setInt(13, MAX_HAYSTACK_LENGTH);
        ps.setString(14, pending.id());
    }

    private static void setNullableDouble(PreparedStatement ps, int index, Double value) throws SQLException {
        if (value != null) {
            ps.setDouble(index, value);
        } else {
            ps.setNull(index, Types.DOUBLE);
        }
    }

    private void bindCompletionResponse(PreparedStatement ps, PendingCompletion pending) throws SQLException {
        ResponseData response = pending.response();
        ps.setString(1, toJson(response != null ? response.headers() : null));
        ps.setString(2, response != null ? response.body() : null);
        ps.setString(3, pending.id());
    }

    /**
     * How many of the oldest calls to remove in one pass: a tenth of what's there, never more than
     * {@link #MAX_DELETE_BATCH}, never enough to drop below {@link #MIN_RETAINED_CALLS}.
     *
     * <p>Proportional rather than a flat 1000 because a flat batch overshoots badly on a small
     * database - with 201 calls it deleted all 201 in a single pass, which is the wipe this whole
     * change exists to prevent. A tenth converges on the target from above instead, and the cap at
     * 1000 keeps each pass cheap when there are millions of rows.
     */
    private static int deleteBatchSize(int rows) {
        int roomAboveFloor = rows - MIN_RETAINED_CALLS;
        int proportional = Math.max(1, rows / 10);
        return Math.max(1, Math.min(Math.min(proportional, MAX_DELETE_BATCH), roomAboveFloor));
    }

    /**
     * Bytes of the database actually holding data - page_count minus the freelist, times page size.
     *
     * <p>This, not {@code Files.size}, is what retention measures against. A DELETE moves pages to
     * the freelist immediately but does not shrink the file, and the pragma that hands those pages
     * back to the OS cannot be driven from JDBC: {@code PRAGMA incremental_vacuum} frees one page
     * per <em>step</em>, {@code jdbcTemplate.execute} steps it exactly once (measured: 4KB reclaimed
     * out of a 9MB freelist), and {@code jdbcTemplate.query} refuses it outright because it returns
     * no rows. Reclaiming 10GB that way would need millions of round trips.
     *
     * <p>Which is fine, because truncation was never what bounds the file: SQLite allocates from the
     * freelist before extending, so pages freed here are reused by the calls that arrive next and
     * the file stops growing at roughly the cap either way. Measuring used bytes also makes the
     * retention loop terminate on something a DELETE changes immediately.
     */
    private long usedBytes() {
        Long pageCount = jdbcTemplate.queryForObject("PRAGMA page_count", Long.class);
        Long freelist = jdbcTemplate.queryForObject("PRAGMA freelist_count", Long.class);
        Long pageSize = jdbcTemplate.queryForObject("PRAGMA page_size", Long.class);
        if (pageCount == null || freelist == null || pageSize == null) {
            return 0L;
        }
        return Math.max(0L, pageCount - freelist) * pageSize;
    }

    /**
     * Deletes the oldest calls (by their own timestamp) until the database holds at most
     * maxSizeBytes of actual data - the "up to N bytes" mechanism. Only ever deletes from
     * call_metadata; the matching call_request/call_response rows go via ON DELETE CASCADE.
     *
     * <p>Measured against {@link #usedBytes()} rather than {@code Files.size}. The original version
     * looped on the file size, which a DELETE does not change - so its condition stayed true no
     * matter how much it deleted, and its only real exit was {@code deleted == 0}, an EMPTY TABLE.
     * The first time a deployment reached its cap it would have discarded every logged call instead
     * of the oldest few. (It never showed up in tests because a freshly-created database gets
     * auto_vacuum=INCREMENTAL and shrinks, while every pre-existing one reports NONE and does not -
     * see {@link #ensureIncrementalAutoVacuum()}.)
     *
     * <p>The no-progress guard is the remaining safety net: if a batch somehow fails to reduce the
     * used bytes, stop and say so rather than delete another batch.
     */
    private void enforceRetention() {
        long used = usedBytes();
        if (used <= maxSizeBytes) {
            return;
        }
        log.info("calls.db holds {} bytes of data, above the {} byte retention target - trimming oldest calls",
                used, maxSizeBytes);
        int rows = count();
        int totalDeleted = 0;
        while (used > maxSizeBytes) {
            if (rows <= MIN_RETAINED_CALLS) {
                log.error("calls.db still holds {} bytes with only {} call(s) left - the {} byte retention target is "
                        + "below this database's fixed overhead (schema and FTS index), so it cannot be met. Stopping "
                        + "rather than deleting the last calls; raise ALFRED_CALLS_MAX_SIZE_BYTES.",
                        used, rows, maxSizeBytes);
                break;
            }
            int batch = deleteBatchSize(rows);
            int deleted = jdbcTemplate.update(
                    "DELETE FROM call_metadata WHERE id IN (SELECT id FROM call_metadata ORDER BY timestamp_millis ASC LIMIT ?)", batch);
            if (deleted == 0) {
                break;
            }
            totalDeleted += deleted;
            rows -= deleted;

            long remaining = usedBytes();
            if (remaining >= used) {
                log.error("calls.db still holds {} bytes after deleting {} call(s) - stopping retention rather than "
                        + "continuing to delete", remaining, deleted);
                break;
            }
            used = remaining;
        }
        // Best-effort hand-back of a page to the OS. Deliberately not what bounds the file (see
        // usedBytes) - SQLite reuses freelist pages for the calls that arrive next.
        try {
            jdbcTemplate.execute("PRAGMA incremental_vacuum");
        } catch (Exception e) {
            log.debug("incremental_vacuum after retention failed (non-fatal): {}", e.getMessage());
        }
        log.info("Trimmed {} oldest call(s) from calls.db, now holding {} bytes of data", totalDeleted, used);
    }

    /**
     * List/search columns only - deliberately excludes request/response headers/body/haystack.
     * Those live in call_request/call_response now, never even joined in for this query - list
     * pages used to force every matching row's full bodies off disk (back when everything lived
     * in one wide table) only for CallsService to immediately discard them building CallSummary.
     * Detail view (findById) still needs the full 3-way join.
     */
    /**
     * Seatbelt on {@link #findResolvedInRange}. The window the dashboard asks about is bounded by
     * the page it has loaded, so this is never reached in normal use - it exists so that a window
     * covering a year can never turn back into "load everything", which is the bug this query was
     * written to remove.
     */
    private static final int MAX_OVERLAP_ROWS = 5000;

    private static final String SUMMARY_SQL =
            "SELECT id, original_url, url, method, timestamp, duration_ms, status, error, supplier_name, status_state, session_id, operation_id, service_name, connect_ms, tls_ms, ttfb_ms, download_ms, reused_connection, interception FROM ";

    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        return query(search, supplier, sort, offset, limit, paginationEnabled, "", "", "");
    }

    /**
     * As above, plus three optional substring filters scoped to one column each - {@code sessionId}
     * against {@code session_id}, {@code operationId} against {@code operation_id}, {@code requestId}
     * against the call's own {@code id} - each ANDed onto the same WHERE clause as search/supplier
     * when non-blank, narrowing rather than widening the result.
     */
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                                     String sessionId, String operationId, String requestId) {
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        String supplierFilter = supplier == null ? "" : supplier.trim();
        String sessionIdFilter = sessionId == null ? "" : sessionId.trim();
        String operationIdFilter = operationId == null ? "" : operationId.trim();
        String requestIdFilter = requestId == null ? "" : requestId.trim();

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> params = new ArrayList<>();
        boolean useFts = ftsAvailable && !query.isEmpty();
        String fromClause = "call_metadata";
        if (useFts) {
            fromClause = "call_metadata JOIN calls_fts ON call_metadata.rowid = calls_fts.rowid";
            where.append(" AND calls_fts MATCH ?");
            params.add(ftsQuery(query));
        } else if (!query.isEmpty()) {
            where.append(" AND call_metadata.haystack LIKE ?");
            params.add("%" + query + "%");
        }
        if (!supplierFilter.isEmpty()) {
            where.append(" AND call_metadata.supplier = ?");
            params.add(supplierFilter);
        }
        if (!sessionIdFilter.isEmpty()) {
            where.append(" AND call_metadata.session_id LIKE ?");
            params.add("%" + sessionIdFilter + "%");
        }
        if (!operationIdFilter.isEmpty()) {
            where.append(" AND call_metadata.operation_id LIKE ?");
            params.add("%" + operationIdFilter + "%");
        }
        if (!requestIdFilter.isEmpty()) {
            where.append(" AND call_metadata.id LIKE ?");
            params.add("%" + requestIdFilter + "%");
        }

        int total = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM " + fromClause + where, Integer.class, params.toArray());

        String orderBy = orderByFor(sort);
        int effectiveLimit = paginationEnabled ? Math.max(limit, 0) : Math.max(limit, 0);
        int effectiveOffset = paginationEnabled ? Math.max(offset, 0) : 0;

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(effectiveLimit);
        pageParams.add(effectiveOffset);

        List<CallSummary> items = jdbcTemplate.query(
                SUMMARY_SQL + fromClause + where + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?",
                SUMMARY_ROW_MAPPER, pageParams.toArray());

        return new CallListSupport.Page<>(items, total);
    }

    /**
     * Resolved calls whose timestamp falls inside {@code [from, to]} - the query behind
     * /call-overlaps, which draws the "what else was in flight while this ran" bars.
     *
     * <p>This exists because the port's default answers the same question by calling
     * {@link #readAll()} and filtering in Java, and readAll is {@code SELECT ... cr.body,
     * cp.body ... } over the WHOLE table: every call ever logged, both bodies included, to produce
     * a handful of entries for a five-minute window. Measured on a 66 MB database of 1,704 calls:
     * <strong>3.0 seconds and hundreds of megabytes of allocation to return 8 KB</strong>. The
     * dashboard asks this question again every time a call arrives (the loaded list's time range
     * moves, see call-list-view's overlapRange) and once per open tab, so a search fanning out to
     * eight suppliers loaded the entire database eight times over. That is what drove the heap into
     * a GC spiral at 600-750% CPU and then OutOfMemoryError, after which the backend accepted
     * connections and answered nothing.
     *
     * <p>Only six columns are selected because {@code CallOverlapEntry} only has six fields - the
     * bodies were always thrown away. They live in their own tables, so naming only call_metadata
     * means SQLite never reads a body page off disk and Java never builds those strings. The
     * window itself rides {@code idx_call_metadata_timestamp_millis}.
     */
    public List<CallRecord> findResolvedInRange(Instant from, Instant to, String search, String supplier) {
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        String supplierFilter = supplier == null ? "" : supplier.trim();

        StringBuilder where = new StringBuilder(
                " WHERE call_metadata.timestamp_millis BETWEEN ? AND ?"
                        + " AND call_metadata.status_state != 'IN_PROGRESS'");
        List<Object> params = new ArrayList<>();
        params.add(from.toEpochMilli());
        params.add(to.toEpochMilli());

        // Same search/supplier handling as query() above - one place decides what "matches" means
        // for this table, whether the caller is paging the list or asking about a window.
        String fromClause = "call_metadata";
        if (ftsAvailable && !query.isEmpty()) {
            fromClause = "call_metadata JOIN calls_fts ON call_metadata.rowid = calls_fts.rowid";
            where.append(" AND calls_fts MATCH ?");
            params.add(ftsQuery(query));
        } else if (!query.isEmpty()) {
            where.append(" AND call_metadata.haystack LIKE ?");
            params.add("%" + query + "%");
        }
        if (!supplierFilter.isEmpty()) {
            where.append(" AND call_metadata.supplier = ?");
            params.add(supplierFilter);
        }
        params.add(MAX_OVERLAP_ROWS);

        return jdbcTemplate.query(
                "SELECT call_metadata.id, call_metadata.timestamp, call_metadata.duration_ms, call_metadata.status,"
                        + " call_metadata.error, call_metadata.status_state, call_metadata.service_name FROM " + fromClause
                        + where + " ORDER BY call_metadata.timestamp_millis ASC LIMIT ?",
                OVERLAP_ROW_MAPPER, params.toArray());
    }

    /**
     * p50/p95 of every COMPLETED call to this exact url.
     *
     * <p>SQLite has no percentile function, so this takes the value at the ordered offset - which is
     * exactly what a percentile is, and lets the existing index do the ordering rather than pulling
     * every duration into memory to sort. Only completed calls count: an in-progress one has no
     * duration yet, and a failed one's duration measures how long it took to fail, which is not a
     * sample of how long this endpoint takes to answer.
     */
    public CallBaseline baselineFor(String url) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM call_metadata WHERE url = ? AND status_state = 'COMPLETED' AND duration_ms IS NOT NULL",
                Integer.class, url);
        if (count == null || count == 0) {
            return CallBaseline.empty(url);
        }
        return new CallBaseline(url, count, durationAtPercentile(url, count, 0.50), durationAtPercentile(url, count, 0.95));
    }

    private Double durationAtPercentile(String url, int count, double percentile) {
        int offset = Math.min(count - 1, Math.max(0, (int) Math.floor(count * percentile)));
        return jdbcTemplate.query(
                """
                SELECT duration_ms FROM call_metadata
                WHERE url = ? AND status_state = 'COMPLETED' AND duration_ms IS NOT NULL
                ORDER BY duration_ms LIMIT 1 OFFSET ?
                """,
                rs -> rs.next() ? rs.getDouble(1) : null, url, offset);
    }

    public int count() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM call_metadata", Integer.class);
        return result == null ? 0 : result;
    }

    /** Bytes currently on disk for calls.db - drives the Database settings tab's file-size table. Returns 0 if the file doesn't exist yet rather than throwing. */
    public long storageSizeBytes() {
        try {
            return Files.size(Path.of(dbFile));
        } catch (IOException e) {
            return 0L;
        }
    }

    /** Single grouped-count query rather than one query per bucket - error takes priority over status (mirrors statusRank's own precedence), then the usual HTTP status class ranges; in-progress is its own bucket, keyed off status_state rather than inferred from null status/error (which is also true of a genuinely completed call whose response legitimately carried no status). */
    public CallStatusBreakdown statusBreakdown() {
        return jdbcTemplate.queryForObject("""
                SELECT
                  COUNT(*) AS total,
                  SUM(CASE WHEN status_state = 'COMPLETED' AND status BETWEEN 200 AND 399 THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN status_state = 'COMPLETED' AND status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS client_error,
                  SUM(CASE WHEN status_state = 'ERROR' OR (status_state = 'COMPLETED' AND status >= 500) THEN 1 ELSE 0 END) AS server_error,
                  SUM(CASE WHEN status_state = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress
                FROM call_metadata
                """, (rs, rowNum) -> new CallStatusBreakdown(
                rs.getLong("total"), rs.getLong("ok"), rs.getLong("client_error"), rs.getLong("server_error"), rs.getLong("in_progress")));
    }

    /** Permanently deletes every call - deleting from call_metadata cascades to call_request/call_response, and the calls_fts external-content triggers keep the FTS index in sync automatically. Runs a best-effort VACUUM afterward so the freed pages are actually reclaimed on disk rather than left as free space inside an unchanged-size file. */
    public void deleteAll() {
        jdbcTemplate.update("DELETE FROM call_metadata");
        try {
            jdbcTemplate.execute("VACUUM");
        } catch (Exception e) {
            log.warn("VACUUM after clearing calls.db failed (non-fatal): {}", e.getMessage());
        }
    }

    /**
     * Used for GET /calls/{id}/detail (which only ever reads request()/response() off the result -
     * see CallDetail.of) AND for the completion fan-out in CallsService.receiveCompletedCall,
     * which is NOT detail-only: that CallRecord is what NewCallObserverPort.onCallCompleted and the
     * WebSocket's notifyCallCompleted actually see. Missing timing/interception here used to mean
     * every observer of a just-completed call - session-cycles' capture chief among them - received
     * a call with both always null, no matter what query()/SUMMARY_ROW_MAPPER correctly returns for
     * the same row a moment later. Live Calls never showed the gap because it re-fetches the
     * authoritative page immediately after a live push and that overwrites the incomplete copy;
     * SessionCycleCaptureAdapter has no such correction - whatever it's handed here is what gets
     * written to captured_call_metadata, permanently.
     */
    private static final String DETAIL_SQL = """
            SELECT cm.id, cm.original_url, cm.url, cm.method, cm.timestamp, cm.duration_ms, cm.status, cm.error, cm.status_state,
                   cm.session_id, cm.operation_id, cm.service_name,
                   cm.connect_ms, cm.tls_ms, cm.ttfb_ms, cm.download_ms, cm.reused_connection, cm.interception,
                   cr.headers AS request_headers, cr.body AS request_body,
                   cp.headers AS response_headers, cp.body AS response_body
            FROM call_metadata cm
            LEFT JOIN call_request cr ON cr.call_id = cm.id
            LEFT JOIN call_response cp ON cp.call_id = cm.id
            WHERE cm.id = ?
            """;

    public Optional<CallRecord> findById(String id) {
        List<CallRecord> results = jdbcTemplate.query(DETAIL_SQL, ROW_MAPPER, id);
        return results.stream().findFirst();
    }

    /**
     * Not the hot path (query() is) - kept for CallLogPort parity/tests. Loads everything (3-way
     * join), so only sensible for small datasets. Shares {@link #ROW_MAPPER} with {@link
     * #findById}, so its own column list has to keep matching whatever that mapper reads - it once
     * didn't, and the moment ROW_MAPPER started reading timing/interception this threw "no such
     * column" for every caller of readAll(), because the SQL text here still only had the original
     * columns bound to different result-set positions.
     */
    public List<CallRecord> readAll() {
        return jdbcTemplate.query("""
                SELECT cm.id, cm.original_url, cm.url, cm.method, cm.timestamp, cm.duration_ms, cm.status, cm.error, cm.status_state,
                       cm.session_id, cm.operation_id, cm.service_name,
                       cm.connect_ms, cm.tls_ms, cm.ttfb_ms, cm.download_ms, cm.reused_connection, cm.interception,
                       cr.headers AS request_headers, cr.body AS request_body,
                       cp.headers AS response_headers, cp.body AS response_body
                FROM call_metadata cm
                LEFT JOIN call_request cr ON cr.call_id = cm.id
                LEFT JOIN call_response cp ON cp.call_id = cm.id
                ORDER BY cm.rowid ASC
                """, ROW_MAPPER);
    }

    private static String orderByFor(String sort) {
        String mode = sort == null ? "newest" : sort;
        return switch (mode) {
            case "oldest" -> "call_metadata.rowid ASC";
            case "oldest-call" -> "call_metadata.timestamp_millis ASC";
            case "newest-call" -> "call_metadata.timestamp_millis DESC";
            case "slowest" -> "COALESCE(call_metadata.duration_ms, -1) DESC";
            case "fastest" -> "COALESCE(call_metadata.duration_ms, 1e18) ASC";
            case "status" -> "call_metadata.status_rank DESC";
            default -> "call_metadata.rowid DESC"; // "newest" and anything unrecognized
        };
    }

    /** FTS5 trigram MATCH treats the query as a phrase pattern - quoting it turns arbitrary user input (which may contain FTS operators like AND/OR/NOT/*) into a literal substring match, mirroring CallListSupport's plain `.contains()`. */
    private static String ftsQuery(String query) {
        return "\"" + query.replace("\"", "\"\"") + "\"";
    }

    private static int statusRank(ResponseData response, String error) {
        if (error != null && !error.isBlank()) {
            return 999;
        }
        Integer status = response != null ? response.status() : null;
        return status == null ? -1 : status;
    }

    /** Mirrors CallListSupport.callTimeMillis exactly - an unparseable/missing timestamp sorts as epoch 0 rather than throwing. */
    private static long callTimeMillis(CallRecord call) {
        String ts = call.timestamp();
        if (ts == null || ts.isBlank()) {
            return 0L;
        }
        try {
            return Instant.parse(ts).toEpochMilli();
        } catch (DateTimeParseException e) {
            try {
                return OffsetDateTime.parse(ts).toInstant().toEpochMilli();
            } catch (DateTimeParseException e2) {
                return 0L;
            }
        }
    }

    /**
     * Trigram-tokenizing the full haystack is O(text length) with a real constant factor -
     * indexing a 300-600KB body synchronously on the webhook request thread measurably slows
     * down every single incoming call. Capped so indexing cost stays bounded regardless of how
     * large a response body gets; the full, untruncated body is still stored in call_response.body
     * and used for detail view and the LIKE-based fallback search - only the FTS index itself is
     * capped, so most real search terms (short strings near the start of headers/body) still hit.
     */
    private static final int MAX_HAYSTACK_LENGTH = 20_000;

    /**
     * The request-only slice of the haystack (method/urls/request headers/body) - computed and
     * persisted (in {@code request_haystack}) at insert time regardless of whether the call is
     * already complete, so {@link #complete} can extend it into the full mixed haystack purely in
     * SQL (string concatenation) without a SELECT to reconstruct this text first.
     */
    private static String buildRequestHaystack(CallRecord call) {
        StringBuilder sb = new StringBuilder();
        append(sb, call.id());
        append(sb, call.sessionId());
        append(sb, call.operationId());
        append(sb, call.method());
        append(sb, call.originalUrl());
        append(sb, call.url());
        if (call.request() != null) {
            if (call.request().headers() != null) {
                sb.append(call.request().headers()).append(' ');
            }
            append(sb, call.request().body());
        }
        return cap(sb.toString().toLowerCase(Locale.ROOT));
    }

    /** The response-only slice of the haystack (status/response headers/body/error) - not capped individually, since it's only ever used concatenated onto request_haystack, capped as a whole (see UPDATE_METADATA_SQL and buildHaystack). */
    private static String buildResponseHaystackFragment(ResponseData response, String error) {
        StringBuilder sb = new StringBuilder();
        if (response != null) {
            if (response.status() != null) {
                sb.append(response.status()).append(' ');
            }
            if (response.headers() != null) {
                sb.append(response.headers()).append(' ');
            }
            append(sb, response.body());
        }
        append(sb, error);
        return sb.toString().toLowerCase(Locale.ROOT);
    }

    /** Mirrors CallListSupport.matchesSearch's haystack construction (method/urls/status/headers/error/bodies, lowercased), truncated to MAX_HAYSTACK_LENGTH before indexing. Degrades gracefully to just {@code requestHaystack} for a still-in-progress call (response/error both null). */
    private static String buildHaystack(CallRecord call, String requestHaystack) {
        String responseFragment = buildResponseHaystackFragment(call.response(), call.error());
        return cap(requestHaystack + " " + responseFragment);
    }

    private static String cap(String haystack) {
        return haystack.length() > MAX_HAYSTACK_LENGTH ? haystack.substring(0, MAX_HAYSTACK_LENGTH) : haystack;
    }

    private static void append(StringBuilder sb, String value) {
        sb.append(value == null ? "" : value).append(' ');
    }

    private String toJson(Map<String, String> headers) {
        if (headers == null) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(headers);
        } catch (Exception e) {
            return null;
        }
    }

    private Map<String, String> fromJson(String json) {
        if (json == null) {
            return null;
        }
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, String>>() {});
        } catch (Exception e) {
            return null;
        }
    }

    private final RowMapper<CallRecord> ROW_MAPPER = (rs, rowNum) -> {
        Map<String, String> requestHeaders = fromJson(rs.getString("request_headers"));
        String requestBody = rs.getString("request_body");
        RequestData request = (requestHeaders == null && requestBody == null) ? null : new RequestData(requestHeaders, requestBody);

        Object statusObj = rs.getObject("status");
        Integer status = statusObj == null ? null : rs.getInt("status");
        Map<String, String> responseHeaders = fromJson(rs.getString("response_headers"));
        String responseBody = rs.getString("response_body");
        ResponseData response = (status == null && responseHeaders == null && responseBody == null)
                ? null : new ResponseData(status, responseHeaders, responseBody);

        Object durationObj = rs.getObject("duration_ms");
        Double durationMs = durationObj == null ? null : rs.getDouble("duration_ms");

        return new CallRecord(
                rs.getString("id"),
                rs.getString("original_url"),
                rs.getString("url"),
                rs.getString("method"),
                request,
                rs.getString("timestamp"),
                durationMs,
                response,
                rs.getString("error"),
                CallLifecycleStatus.valueOf(rs.getString("status_state")),
                rs.getString("session_id"),
                rs.getString("operation_id"),
                rs.getString("service_name"),
                timingOf(rs),
                interceptionOf(rs));
    };

    /** Reads a row of the OLD (pre-split) single-table {@code calls} shape - used only by {@link #migrateLegacySingleTableIfPresent}. That legacy table predates service_name entirely (it predates even session_id/operation_id), so this always passes null for it rather than reading a column that was never added to {@code calls}. */
    private static final RowMapper<CallRecord> LEGACY_ROW_MAPPER = (rs, rowNum) -> {
        ObjectMapper mapper = new ObjectMapper();
        Map<String, String> requestHeaders = legacyFromJson(mapper, rs.getString("request_headers"));
        String requestBody = rs.getString("request_body");
        RequestData request = (requestHeaders == null && requestBody == null) ? null : new RequestData(requestHeaders, requestBody);

        Object statusObj = rs.getObject("status");
        Integer status = statusObj == null ? null : rs.getInt("status");
        Map<String, String> responseHeaders = legacyFromJson(mapper, rs.getString("response_headers"));
        String responseBody = rs.getString("response_body");
        ResponseData response = (status == null && responseHeaders == null && responseBody == null)
                ? null : new ResponseData(status, responseHeaders, responseBody);

        Object durationObj = rs.getObject("duration_ms");
        Double durationMs = durationObj == null ? null : rs.getDouble("duration_ms");

        return new CallRecord(
                rs.getString("id"),
                rs.getString("original_url"),
                rs.getString("url"),
                rs.getString("method"),
                request,
                rs.getString("timestamp"),
                durationMs,
                response,
                rs.getString("error"),
                CallLifecycleStatus.valueOf(rs.getString("status_state")),
                rs.getString("session_id"),
                rs.getString("operation_id"),
                null);
    };

    private static Map<String, String> legacyFromJson(ObjectMapper mapper, String json) {
        if (json == null) {
            return null;
        }
        try {
            return mapper.readValue(json, new TypeReference<Map<String, String>>() {});
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Metadata only, for {@link #findResolvedInRange}: request and response are left null apart
     * from the status, because the one consumer (CallOverlapEntry) reads nothing else. Anything
     * that needs a body asks for that call by id.
     */
    private static final RowMapper<CallRecord> OVERLAP_ROW_MAPPER = (rs, rowNum) -> {
        Object statusObj = rs.getObject("status");
        Integer status = statusObj == null ? null : rs.getInt("status");
        Object durationObj = rs.getObject("duration_ms");
        Double durationMs = durationObj == null ? null : rs.getDouble("duration_ms");

        return new CallRecord(
                rs.getString("id"),
                null,
                null,
                null,
                null,
                rs.getString("timestamp"),
                durationMs,
                status == null ? null : new ResponseData(status, null, null),
                rs.getString("error"),
                CallLifecycleStatus.valueOf(rs.getString("status_state")),
                null,
                null,
                rs.getString("service_name"),
                null,
                null);
    };

    private static final RowMapper<CallSummary> SUMMARY_ROW_MAPPER = (rs, rowNum) -> {
        Object statusObj = rs.getObject("status");
        Integer status = statusObj == null ? null : rs.getInt("status");
        Object durationObj = rs.getObject("duration_ms");
        Double durationMs = durationObj == null ? null : rs.getDouble("duration_ms");

        return new CallSummary(
                rs.getString("id"),
                rs.getString("original_url"),
                rs.getString("url"),
                rs.getString("method"),
                rs.getString("timestamp"),
                durationMs,
                status,
                rs.getString("error"),
                nullIfEmpty(rs.getString("supplier_name")),
                CallLifecycleStatus.valueOf(rs.getString("status_state")),
                rs.getString("session_id"),
                rs.getString("operation_id"),
                rs.getString("service_name"),
                timingOf(rs),
                interceptionOf(rs));
    };

    /**
     * The phase timings ride along with the SUMMARY, not the detail: the waterfall needs them for
     * every call in the list at once, and five numbers per row cost far less than the bodies the
     * summary deliberately leaves behind. Returns null rather than a record of nulls when nothing
     * was measured, so "not measured" stays distinguishable from "measured as zero".
     */
    /**
     * Stored as JSON text, so it round-trips whatever the proxy reported without this repository
     * needing to know the shape of every action. A row written before this column existed reads
     * back null, which is correct: no rule touched that call.
     */
    private String writeInterception(CallInterception interception) {
        if (interception == null || interception.isEmpty()) {
            return null;
        }
        try {
            return INTERCEPTION_MAPPER.writeValueAsString(interception);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            log.warn("Could not store interception record for a call: {}", e.getMessage());
            return null;
        }
    }

    private static CallInterception interceptionOf(ResultSet rs) throws SQLException {
        String json = rs.getString("interception");
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return INTERCEPTION_MAPPER.readValue(json, CallInterception.class);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            // An unreadable record must not take the call down with it - the call itself is the
            // thing being logged; this is an annotation on it.
            return null;
        }
    }

    private static final com.fasterxml.jackson.databind.ObjectMapper INTERCEPTION_MAPPER =
            new com.fasterxml.jackson.databind.ObjectMapper();

    private static CallTiming timingOf(ResultSet rs) throws SQLException {
        Double connect = nullableDouble(rs, "connect_ms");
        Double tls = nullableDouble(rs, "tls_ms");
        Double ttfb = nullableDouble(rs, "ttfb_ms");
        Double download = nullableDouble(rs, "download_ms");
        Object reusedObj = rs.getObject("reused_connection");
        Boolean reused = reusedObj == null ? null : rs.getInt("reused_connection") != 0;
        CallTiming timing = new CallTiming(connect, tls, ttfb, download, reused);
        return timing.isEmpty() ? null : timing;
    }

    private static Double nullableDouble(ResultSet rs, String column) throws SQLException {
        Object value = rs.getObject(column);
        return value == null ? null : rs.getDouble(column);
    }

    /** Undoes the ""-instead-of-NULL storage trick from bindMetadata - external behavior stays "null when there's no supplier name", exactly as CallSummary.of() always returned. */
    private static String nullIfEmpty(String value) {
        return (value == null || value.isEmpty()) ? null : value;
    }

    /** Used only by the startup migrator so it never has to know a legacy line without an id needs one generated - same rule FileCallLogAdapter applies while it's still the active adapter. */
    public static CallRecord withGeneratedIdIfMissing(CallRecord call) {
        return call.id() != null ? call : new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(),
                call.method(), call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }
}
