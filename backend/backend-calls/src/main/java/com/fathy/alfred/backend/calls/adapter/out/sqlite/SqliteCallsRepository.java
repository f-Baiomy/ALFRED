package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.SQLException;
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
    private int savesSinceLastSizeCheck;

    /** The outcome half of a two-phase call, awaiting write via {@link #completionWriter} - see {@link #complete}. */
    private record PendingCompletion(String id, ResponseData response, String error, Double durationMs) {}

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

        // auto_vacuum is a database-level (not per-connection) setting, persisted in the file
        // itself - fine to set once here.
        jdbcTemplate.execute("PRAGMA auto_vacuum=INCREMENTAL");

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
                  operation_id TEXT
                )
                """);
        addSessionOperationColumnsIfMissing();
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
                               session_id, operation_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
              haystack = substr(COALESCE(request_haystack, '') || ' ' || ?, 1, ?)
            WHERE id = ?
            """;

    private static final String UPDATE_RESPONSE_SQL = "UPDATE call_response SET headers = ?, body = ? WHERE call_id = ?";

    /** Second half of two-phase logging - fills in a previously-{@link #save prepared} call's outcome. @return true if a row with this id existed to update. */
    public boolean complete(String id, ResponseData response, String error, Double durationMs) {
        Integer existing = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM call_metadata WHERE id = ?", Integer.class, id);
        if (existing == null || existing == 0) {
            return false;
        }
        completionWriter.submit(new PendingCompletion(id, response, error, durationMs));
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
        ps.setString(6, buildResponseHaystackFragment(response, error));
        ps.setInt(7, MAX_HAYSTACK_LENGTH);
        ps.setString(8, pending.id());
    }

    private void bindCompletionResponse(PreparedStatement ps, PendingCompletion pending) throws SQLException {
        ResponseData response = pending.response();
        ps.setString(1, toJson(response != null ? response.headers() : null));
        ps.setString(2, response != null ? response.body() : null);
        ps.setString(3, pending.id());
    }

    /** Deletes the oldest rows (by the call's own timestamp) until the on-disk file is back under maxSizeBytes, then reclaims the freed pages - this is the actual "up to 100GB" mechanism. Only ever deletes from call_metadata - the matching call_request/call_response rows are removed automatically via ON DELETE CASCADE. */
    private void enforceRetention() {
        try {
            long size = Files.size(Path.of(dbFile));
            if (size <= maxSizeBytes) {
                return;
            }
            log.info("calls.db is {} bytes, above the {} byte retention target - trimming oldest rows", size, maxSizeBytes);
            int batch = 1000;
            int totalDeleted = 0;
            while (Files.size(Path.of(dbFile)) > maxSizeBytes) {
                int deleted = jdbcTemplate.update(
                        "DELETE FROM call_metadata WHERE id IN (SELECT id FROM call_metadata ORDER BY timestamp_millis ASC LIMIT ?)", batch);
                totalDeleted += deleted;
                if (deleted == 0) {
                    break;
                }
            }
            jdbcTemplate.execute("PRAGMA incremental_vacuum");
            log.info("Trimmed {} oldest call(s) from calls.db during retention enforcement", totalDeleted);
        } catch (IOException e) {
            log.warn("Could not stat {} for retention enforcement: {}", dbFile, e.getMessage());
        }
    }

    /**
     * List/search columns only - deliberately excludes request/response headers/body/haystack.
     * Those live in call_request/call_response now, never even joined in for this query - list
     * pages used to force every matching row's full bodies off disk (back when everything lived
     * in one wide table) only for CallsService to immediately discard them building CallSummary.
     * Detail view (findById) still needs the full 3-way join.
     */
    private static final String SUMMARY_SQL =
            "SELECT id, original_url, url, method, timestamp, duration_ms, status, error, supplier_name, status_state, session_id, operation_id FROM ";

    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        String supplierFilter = supplier == null ? "" : supplier.trim();

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

    private static final String DETAIL_SQL = """
            SELECT cm.id, cm.original_url, cm.url, cm.method, cm.timestamp, cm.duration_ms, cm.status, cm.error, cm.status_state,
                   cm.session_id, cm.operation_id,
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

    /** Not the hot path (query() is) - kept for CallLogPort parity/tests. Loads everything (3-way join), so only sensible for small datasets. */
    public List<CallRecord> readAll() {
        return jdbcTemplate.query("""
                SELECT cm.id, cm.original_url, cm.url, cm.method, cm.timestamp, cm.duration_ms, cm.status, cm.error, cm.status_state,
                       cm.session_id, cm.operation_id,
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
                rs.getString("operation_id"));
    };

    /** Reads a row of the OLD (pre-split) single-table {@code calls} shape - used only by {@link #migrateLegacySingleTableIfPresent}. */
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
                rs.getString("operation_id"));
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
                rs.getString("operation_id"));
    };

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
