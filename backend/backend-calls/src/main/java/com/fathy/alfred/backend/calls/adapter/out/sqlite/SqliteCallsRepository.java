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
        config.setJdbcUrl("jdbc:sqlite:" + path);
        config.setMaximumPoolSize(20);
        config.setPoolName("calls-sqlite-pool");
        // journal_mode/synchronous/busy_timeout are per-CONNECTION settings in SQLite, not
        // persisted in the database file - running them once via jdbcTemplate.execute() only
        // applied to whichever single pooled connection happened to be grabbed at startup, so the
        // rest of the pool kept SQLite's default busy_timeout=0 (fail immediately instead of
        // waiting) and synchronous=FULL. That's what caused SQLITE_BUSY / "database is locked" to
        // intermittently drop an incoming call whenever two webhook requests wrote at the same
        // time. connectionInitSql runs on every physical connection Hikari opens, so all of them
        // get the same settings - a 10s busy_timeout means a second concurrent writer waits for
        // the first to finish instead of failing outright. Pool size 20 (not the original 4) gives
        // concurrent GET /calls reads enough headroom that a burst of writes funneled through
        // BatchWriter's single writer thread doesn't starve them of a pooled connection.
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        // auto_vacuum is a database-level (not per-connection) setting, persisted in the file
        // itself - fine to set once here.
        jdbcTemplate.execute("PRAGMA auto_vacuum=INCREMENTAL");

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS calls (
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
                  request_headers TEXT,
                  request_body TEXT,
                  response_headers TEXT,
                  response_body TEXT,
                  haystack TEXT
                )
                """);
        addSupplierNameColumnIfMissing();
        addLifecycleColumnsIfMissing();
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_timestamp_millis ON calls(timestamp_millis)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_supplier ON calls(supplier)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_status_rank ON calls(status_rank)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_duration ON calls(duration_ms)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_status_state ON calls(status_state)");

        initFts();
        backfillSupplierNameIfNeeded();

        // Group-commit writer: exactly one thread ever opens a write transaction against
        // calls.db, so concurrent webhook calls never contend for SQLite's single write lock with
        // each other, and a burst that arrives while a commit is in flight gets folded into the
        // next transaction instead of each paying for its own commit. See BatchWriter's own doc.
        // Queue capacity of 1000 comfortably exceeds Tomcat's default max worker threads (200) -
        // see BatchWriter's queueCapacity doc for why that's the number that actually matters.
        this.insertWriter = new BatchWriter<>("calls-sqlite-writer", dataSource, INSERT_SQL, this::bindCall, 1000);
        // A second, independent writer for the two-phase "complete" UPDATE - same rationale as
        // insertWriter (one dedicated thread, no cross-request lock contention), but a distinct
        // instance since BatchWriter is bound to one fixed SQL statement/bind function. SQLite only
        // ever allows one writer at a time regardless (WAL mode + busy_timeout already serializes
        // the two threads against each other exactly like it does for concurrent inserts today).
        this.completionWriter = new BatchWriter<>("calls-sqlite-completion-writer", dataSource, UPDATE_SQL, this::bindCompletion, 1000);
    }

    /** FTS5 with the trigram tokenizer mirrors CallListSupport.matchesSearch's `.contains(query)` substring semantics far more closely than the default whole-token tokenizer. Falls back to a plain `LIKE` scan over the haystack column if this SQLite build lacks FTS5/trigram, rather than failing startup. */
    private void initFts() {
        try {
            jdbcTemplate.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS calls_fts USING fts5(
                      haystack, content='calls', content_rowid='rowid', tokenize='trigram'
                    )
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS calls_ai AFTER INSERT ON calls BEGIN
                      INSERT INTO calls_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS calls_ad AFTER DELETE ON calls BEGIN
                      INSERT INTO calls_fts(calls_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS calls_au AFTER UPDATE ON calls BEGIN
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
     * {@code supplier_name} was added after calls.db was already in use in some deployments -
     * {@code CREATE TABLE IF NOT EXISTS} is a no-op against an existing table, so the column has
     * to be added explicitly via {@code ALTER TABLE} for those. SQLite has no
     * {@code ADD COLUMN IF NOT EXISTS}, so check {@code PRAGMA table_info} first.
     */
    private void addSupplierNameColumnIfMissing() {
        boolean alreadyPresent = jdbcTemplate.query("PRAGMA table_info(calls)",
                        (rs, rowNum) -> rs.getString("name"))
                .stream().anyMatch("supplier_name"::equals);
        if (!alreadyPresent) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN supplier_name TEXT");
        }
    }

    /**
     * Two-phase logging (prepare/complete) added {@code status_state} (see
     * {@link CallLifecycleStatus}) and {@code request_haystack} (the request-only slice of
     * {@code haystack}, kept so {@link #complete} can extend it into the full mixed haystack with
     * a single {@code UPDATE ... SET haystack = request_haystack || ...} rather than a SELECT to
     * reconstruct the request-side text first). Every row written before this existed is a
     * completed call (the old single-shot flow never had an in-progress state) - backfilled to
     * {@code COMPLETED}, or {@code ERROR} for rows that already have an error recorded.
     */
    private void addLifecycleColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(calls)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("status_state")) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN status_state TEXT NOT NULL DEFAULT 'COMPLETED'");
            jdbcTemplate.update("UPDATE calls SET status_state = 'ERROR' WHERE error IS NOT NULL AND error != ''");
        }
        if (!columns.contains("request_haystack")) {
            jdbcTemplate.execute("ALTER TABLE calls ADD COLUMN request_haystack TEXT");
        }
    }

    /**
     * supplier_name is normally precomputed at write time (see bindCall) so list queries never
     * need to touch request_body to get it - but rows written before this column existed have it
     * NULL. One-time, streamed (not loaded all at once) backfill from each such row's already-
     * stored request_body, so existing calls don't silently lose their supplier name in list view.
     *
     * <p>Every row this touches (and every row bindCall writes from now on) gets a definite,
     * non-null value: the real supplier name, or {@code ""} if the body genuinely has none - never
     * SQL NULL. That's what makes "already processed" distinguishable from "not yet processed": if
     * a plain body-with-no-supplier-field row were left NULL, this backfill would re-select and
     * re-process it (harmlessly, but pointlessly) on every single restart forever, since nothing
     * would ever change its NULL-ness. {@code ""} round-trips back to {@code null} on read
     * (see ROW_MAPPER/SUMMARY_ROW_MAPPER) so this is purely an internal storage detail - external
     * behavior (CallSummary.supplierName() being null when there's no supplier) is unchanged.
     */
    private void backfillSupplierNameIfNeeded() {
        Integer pending = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM calls WHERE supplier_name IS NULL AND request_body IS NOT NULL", Integer.class);
        if (pending == null || pending == 0) {
            return;
        }
        log.info("Backfilling supplier_name for {} existing call(s)", pending);
        jdbcTemplate.query("SELECT id, request_body FROM calls WHERE supplier_name IS NULL AND request_body IS NOT NULL",
                rs -> {
                    String id = rs.getString("id");
                    String supplierName = CallSummary.supplierNameOfBody(rs.getString("request_body"));
                    jdbcTemplate.update("UPDATE calls SET supplier_name = ? WHERE id = ?", supplierName == null ? "" : supplierName, id);
                });
        // Rows with a NULL (not empty-body, genuinely absent) request_body never match the WHERE
        // clause above and so are never touched - they're allowed to keep supplier_name NULL
        // forever, since there's nothing to derive it from either way and no rescan risk (a NULL
        // request_body can't newly appear on an existing row).
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

    /** Blocks until the call is actually committed - see BatchWriter's class doc for why this is still synchronous (and safe under concurrency) despite writes now being batched. Used both for a fully-resolved call (the legacy single-shot webhook) and for the first half of two-phase logging (state IN_PROGRESS, response/error/durationMs null) - bindCall already handles either shape. */
    public void save(CallRecord call) {
        insertWriter.submit(call);

        if (++savesSinceLastSizeCheck >= SIZE_CHECK_EVERY_N_SAVES) {
            savesSinceLastSizeCheck = 0;
            enforceRetention();
        }
    }

    private static final String INSERT_SQL = """
            INSERT INTO calls (id, original_url, url, method, timestamp, timestamp_millis, duration_ms,
                               status, status_rank, supplier, supplier_name, error, request_headers, request_body,
                               response_headers, response_body, haystack, status_state, request_haystack)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """;

    /** Binds one call's columns onto BatchWriter's persistent, reused PreparedStatement - runs on its single dedicated thread. */
    private void bindCall(PreparedStatement ps, CallRecord call) throws SQLException {
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
        // than SQL NULL when there's genuinely no supplier field - see backfillSupplierNameIfNeeded's
        // doc for why NULL must mean "not yet processed", never "processed, no value".
        String supplierName = CallSummary.supplierNameOf(normalized);
        ps.setString(11, supplierName == null ? "" : supplierName);
        ps.setString(12, normalized.error());
        ps.setString(13, toJson(normalized.request() != null ? normalized.request().headers() : null));
        ps.setString(14, normalized.request() != null ? normalized.request().body() : null);
        ps.setString(15, toJson(normalized.response() != null ? normalized.response().headers() : null));
        ps.setString(16, normalized.response() != null ? normalized.response().body() : null);
        ps.setString(17, haystack);
        ps.setString(18, normalized.state().name());
        ps.setString(19, requestHaystack);
    }

    private static final String UPDATE_SQL = """
            UPDATE calls SET
              status = ?, status_rank = ?, error = ?, response_headers = ?, response_body = ?,
              duration_ms = ?, status_state = ?, haystack = substr(COALESCE(request_haystack, '') || ' ' || ?, 1, ?)
            WHERE id = ?
            """;

    /** Second half of two-phase logging - fills in a previously-{@link #save prepared} call's outcome. @return true if a row with this id existed to update. */
    public boolean complete(String id, ResponseData response, String error, Double durationMs) {
        Integer existing = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM calls WHERE id = ?", Integer.class, id);
        if (existing == null || existing == 0) {
            return false;
        }
        completionWriter.submit(new PendingCompletion(id, response, error, durationMs));
        return true;
    }

    private void bindCompletion(PreparedStatement ps, PendingCompletion pending) throws SQLException {
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
        ps.setString(4, toJson(response != null ? response.headers() : null));
        ps.setString(5, response != null ? response.body() : null);
        if (pending.durationMs() != null) {
            ps.setDouble(6, pending.durationMs());
        } else {
            ps.setNull(6, Types.DOUBLE);
        }
        ps.setString(7, state.name());
        ps.setString(8, buildResponseHaystackFragment(response, error));
        ps.setInt(9, MAX_HAYSTACK_LENGTH);
        ps.setString(10, pending.id());
    }

    /** Deletes the oldest rows (by the call's own timestamp) until the on-disk file is back under maxSizeBytes, then reclaims the freed pages - this is the actual "up to 100GB" mechanism. */
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
                        "DELETE FROM calls WHERE id IN (SELECT id FROM calls ORDER BY timestamp_millis ASC LIMIT ?)", batch);
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
     * List/search columns only - deliberately excludes request_headers/request_body/
     * response_headers/response_body/haystack. Those are large TEXT values SQLite stores in
     * overflow pages; selecting them here (as {@code SELECT calls.*} used to) forced every list
     * page to pull every matching row's full bodies off disk only for CallsService to immediately
     * discard them building CallSummary. Detail view (findById) still needs the full row and still
     * selects everything.
     */
    private static final String SUMMARY_SQL =
            "SELECT id, original_url, url, method, timestamp, duration_ms, status, error, supplier_name, status_state FROM ";

    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        String supplierFilter = supplier == null ? "" : supplier.trim();

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> params = new java.util.ArrayList<>();
        boolean useFts = ftsAvailable && !query.isEmpty();
        String fromClause = "calls";
        if (useFts) {
            fromClause = "calls JOIN calls_fts ON calls.rowid = calls_fts.rowid";
            where.append(" AND calls_fts MATCH ?");
            params.add(ftsQuery(query));
        } else if (!query.isEmpty()) {
            where.append(" AND calls.haystack LIKE ?");
            params.add("%" + query + "%");
        }
        if (!supplierFilter.isEmpty()) {
            where.append(" AND calls.supplier = ?");
            params.add(supplierFilter);
        }

        int total = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM " + fromClause + where, Integer.class, params.toArray());

        String orderBy = orderByFor(sort);
        int effectiveLimit = paginationEnabled ? Math.max(limit, 0) : Math.max(limit, 0);
        int effectiveOffset = paginationEnabled ? Math.max(offset, 0) : 0;

        List<Object> pageParams = new java.util.ArrayList<>(params);
        pageParams.add(effectiveLimit);
        pageParams.add(effectiveOffset);

        List<CallSummary> items = jdbcTemplate.query(
                SUMMARY_SQL + fromClause + where + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?",
                SUMMARY_ROW_MAPPER, pageParams.toArray());

        return new CallListSupport.Page<>(items, total);
    }

    public int count() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM calls", Integer.class);
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
                FROM calls
                """, (rs, rowNum) -> new CallStatusBreakdown(
                rs.getLong("total"), rs.getLong("ok"), rs.getLong("client_error"), rs.getLong("server_error"), rs.getLong("in_progress")));
    }

    /** Permanently deletes every call - the calls_fts external-content triggers keep the FTS index in sync automatically. Runs a best-effort VACUUM afterward so the freed pages are actually reclaimed on disk rather than left as free space inside an unchanged-size file. */
    public void deleteAll() {
        jdbcTemplate.update("DELETE FROM calls");
        try {
            jdbcTemplate.execute("VACUUM");
        } catch (Exception e) {
            log.warn("VACUUM after clearing calls.db failed (non-fatal): {}", e.getMessage());
        }
    }

    public Optional<CallRecord> findById(String id) {
        List<CallRecord> results = jdbcTemplate.query("SELECT * FROM calls WHERE id = ?", ROW_MAPPER, id);
        return results.stream().findFirst();
    }

    /** Not the hot path (query() is) - kept for CallLogPort parity/tests. Loads everything, so only sensible for small datasets or the file-adapter's fallback shape. */
    public List<CallRecord> readAll() {
        return jdbcTemplate.query("SELECT * FROM calls ORDER BY rowid ASC", ROW_MAPPER);
    }

    private static String orderByFor(String sort) {
        String mode = sort == null ? "newest" : sort;
        return switch (mode) {
            case "oldest" -> "calls.rowid ASC";
            case "oldest-call" -> "calls.timestamp_millis ASC";
            case "newest-call" -> "calls.timestamp_millis DESC";
            case "slowest" -> "COALESCE(calls.duration_ms, -1) DESC";
            case "fastest" -> "COALESCE(calls.duration_ms, 1e18) ASC";
            case "status" -> "calls.status_rank DESC";
            default -> "calls.rowid DESC"; // "newest" and anything unrecognized
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
     * large a response body gets; the full, untruncated body is still stored in response_body and
     * used for detail view and the LIKE-based fallback search - only the FTS index itself is
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

    /** The response-only slice of the haystack (status/response headers/body/error) - not capped individually, since it's only ever used concatenated onto request_haystack, capped as a whole (see UPDATE_SQL and buildHaystack). */
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
                CallLifecycleStatus.valueOf(rs.getString("status_state")));
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
                CallLifecycleStatus.valueOf(rs.getString("status_state")));
    };

    /** Undoes the ""-instead-of-NULL storage trick from bindCall/backfillSupplierNameIfNeeded - external behavior stays "null when there's no supplier name", exactly as CallSummary.of() always returned. */
    private static String nullIfEmpty(String value) {
        return (value == null || value.isEmpty()) ? null : value;
    }

    /** Used only by the startup migrator so it never has to know a legacy line without an id needs one generated - same rule FileCallLogAdapter applies while it's still the active adapter. */
    public static CallRecord withGeneratedIdIfMissing(CallRecord call) {
        return call.id() != null ? call : new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(),
                call.method(), call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }
}
