package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.adapter.out.sqlite.BatchWriter;
import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
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
 * Owns every raw SQL/JDBC detail for session-cycles.db - both the session_cycles metadata table
 * and the captured_calls table (one shared file, not one file per cycle the way the JSON adapter
 * worked - see the migration plan). SqliteSessionCycleMetadataStoreAdapter and
 * SqliteCapturedCallsStoreAdapter are thin wrappers that implement their respective ports purely
 * by delegating here, mirroring backend-calls' SqliteCallsRepository/SqliteCallLogAdapter split.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteSessionCyclesRepository {

    private static final Logger log = LoggerFactory.getLogger(SqliteSessionCyclesRepository.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SESSION_CYCLES_DB_FILE:/appdata/session-cycles.db}")
    private String dbFile;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbcTemplate;
    private volatile boolean ftsAvailable;
    private BatchWriter<PendingCapturedCall> batchWriter;

    /** cycleId travels alongside the CapturedCall since captured_calls' INSERT needs it bound too - BatchWriter is generic over one item type, so this pairs them for the batch. */
    private record PendingCapturedCall(String cycleId, CapturedCall captured) {}

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
        config.setPoolName("session-cycles-sqlite-pool");
        // See SqliteCallsRepository's identical comment: journal_mode/synchronous/busy_timeout are
        // per-connection in SQLite, so they must be applied via connectionInitSql (runs on every
        // pooled connection) rather than a one-off jdbcTemplate.execute() - otherwise most of the
        // pool keeps busy_timeout=0 and a concurrent write fails with SQLITE_BUSY instead of
        // waiting, silently dropping a captured call.
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("PRAGMA auto_vacuum=INCREMENTAL");

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS session_cycles (
                  id TEXT PRIMARY KEY,
                  name TEXT,
                  created_at TEXT,
                  assigned_to TEXT,
                  status TEXT
                )
                """);

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS captured_calls (
                  id TEXT PRIMARY KEY,
                  cycle_id TEXT NOT NULL,
                  captured_at TEXT,
                  call_id TEXT,
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
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_captured_calls_cycle ON captured_calls(cycle_id)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_captured_calls_timestamp ON captured_calls(cycle_id, timestamp_millis)");

        initFts();
        backfillSupplierNameIfNeeded();

        // Group-commit writer for captured_calls - see SqliteCallsRepository's identical field for
        // why this eliminates cross-request lock contention on session-cycles.db.
        this.batchWriter = new BatchWriter<>("session-cycles-sqlite-writer", dataSource, INSERT_SQL, this::bindCapturedCall, 1000);
    }

    /** See SqliteCallsRepository's identical method - captured_calls.supplier_name was added after some deployments already had data. */
    private void addSupplierNameColumnIfMissing() {
        boolean alreadyPresent = jdbcTemplate.query("PRAGMA table_info(captured_calls)",
                        (rs, rowNum) -> rs.getString("name"))
                .stream().anyMatch("supplier_name"::equals);
        if (!alreadyPresent) {
            jdbcTemplate.execute("ALTER TABLE captured_calls ADD COLUMN supplier_name TEXT");
        }
    }

    /**
     * See SqliteCallsRepository's identical method (and its doc for why NULL vs "" matters) -
     * one-time backfill for rows captured before supplier_name was populated. Every row touched
     * here (and every row bindCapturedCall writes from now on) gets "" instead of NULL when there's
     * genuinely no supplier field, so it's never re-selected as "still pending" on a later restart.
     */
    private void backfillSupplierNameIfNeeded() {
        Integer pending = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM captured_calls WHERE supplier_name IS NULL AND request_body IS NOT NULL", Integer.class);
        if (pending == null || pending == 0) {
            return;
        }
        log.info("Backfilling supplier_name for {} existing captured call(s)", pending);
        jdbcTemplate.query("SELECT id, request_body FROM captured_calls WHERE supplier_name IS NULL AND request_body IS NOT NULL",
                rs -> {
                    String id = rs.getString("id");
                    String supplierName = CallSummary.supplierNameOfBody(rs.getString("request_body"));
                    jdbcTemplate.update("UPDATE captured_calls SET supplier_name = ? WHERE id = ?", supplierName == null ? "" : supplierName, id);
                });
    }

    private void initFts() {
        try {
            jdbcTemplate.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS captured_calls_fts USING fts5(
                      haystack, content='captured_calls', content_rowid='rowid', tokenize='trigram'
                    )
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS captured_calls_ai AFTER INSERT ON captured_calls BEGIN
                      INSERT INTO captured_calls_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS captured_calls_ad AFTER DELETE ON captured_calls BEGIN
                      INSERT INTO captured_calls_fts(captured_calls_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS captured_calls_au AFTER UPDATE ON captured_calls BEGIN
                      INSERT INTO captured_calls_fts(captured_calls_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
                      INSERT INTO captured_calls_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
                    END
                    """);
            ftsAvailable = true;
        } catch (Exception e) {
            ftsAvailable = false;
            log.warn("FTS5 trigram virtual table unavailable, falling back to LIKE-based search: {}", e.getMessage());
        }
    }

    @PreDestroy
    public void close() {
        if (batchWriter != null) {
            batchWriter.close();
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

    // ---------- session_cycles ----------

    public List<SessionCycle> findAllCycles() {
        return jdbcTemplate.query("SELECT * FROM session_cycles ORDER BY rowid ASC", CYCLE_ROW_MAPPER);
    }

    public Optional<SessionCycle> findCycleById(String id) {
        return jdbcTemplate.query("SELECT * FROM session_cycles WHERE id = ?", CYCLE_ROW_MAPPER, id).stream().findFirst();
    }

    public SessionCycle saveCycle(SessionCycle cycle) {
        jdbcTemplate.update("""
                INSERT INTO session_cycles (id, name, created_at, assigned_to, status)
                VALUES (?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at,
                    assigned_to = excluded.assigned_to, status = excluded.status
                """,
                cycle.id(), cycle.name(), cycle.createdAt(), cycle.assignedTo(), cycle.status().name());
        return cycle;
    }

    public boolean deleteCycleById(String id) {
        return jdbcTemplate.update("DELETE FROM session_cycles WHERE id = ?", id) > 0;
    }

    public int cycleCount() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM session_cycles", Integer.class);
        return result == null ? 0 : result;
    }

    // ---------- captured_calls ----------

    public List<CapturedCall> findAllByCycle(String cycleId) {
        return jdbcTemplate.query("SELECT * FROM captured_calls WHERE cycle_id = ? ORDER BY rowid ASC", CAPTURED_ROW_MAPPER, cycleId);
    }

    public CapturedCall append(String cycleId, CallRecord call) {
        CapturedCall captured = new CapturedCall(UUID.randomUUID().toString(), Instant.now().toString(), call);
        insert(cycleId, captured);
        return captured;
    }

    /** Blocks until actually committed - see BatchWriter's class doc. */
    void insert(String cycleId, CapturedCall captured) {
        batchWriter.submit(new PendingCapturedCall(cycleId, captured));
    }

    private static final String INSERT_SQL = """
            INSERT INTO captured_calls (id, cycle_id, captured_at, call_id, original_url, url, method,
                                         timestamp, timestamp_millis, duration_ms, status, status_rank,
                                         supplier, supplier_name, error, request_headers, request_body,
                                         response_headers, response_body, haystack)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """;

    /** Binds one pending captured call's columns onto BatchWriter's persistent, reused PreparedStatement - runs on its single dedicated thread. */
    private void bindCapturedCall(PreparedStatement ps, PendingCapturedCall pending) throws SQLException {
        String cycleId = pending.cycleId();
        CapturedCall captured = pending.captured();
        CallRecord call = captured.call();
        String haystack = buildHaystack(call);
        Integer status = call.response() != null ? call.response().status() : null;
        ps.setString(1, captured.id());
        ps.setString(2, cycleId);
        ps.setString(3, captured.capturedAt());
        ps.setString(4, call.id());
        ps.setString(5, call.originalUrl());
        ps.setString(6, call.url());
        ps.setString(7, call.method());
        ps.setString(8, call.timestamp());
        ps.setLong(9, callTimeMillis(call));
        if (call.durationMs() != null) {
            ps.setDouble(10, call.durationMs());
        } else {
            ps.setNull(10, Types.DOUBLE);
        }
        if (status != null) {
            ps.setInt(11, status);
        } else {
            ps.setNull(11, Types.INTEGER);
        }
        ps.setInt(12, statusRank(call));
        ps.setString(13, CallListSupport.supplierOf(call));
        // Precomputed here (not derived from request_body on every read) so list/search queries
        // can skip fetching request_body entirely - see query()'s SUMMARY_SQL. Stored as "" rather
        // than SQL NULL when there's genuinely no supplier field - see backfillSupplierNameIfNeeded.
        String supplierName = CallSummary.supplierNameOf(call);
        ps.setString(14, supplierName == null ? "" : supplierName);
        ps.setString(15, call.error());
        ps.setString(16, toJson(call.request() != null ? call.request().headers() : null));
        ps.setString(17, call.request() != null ? call.request().body() : null);
        ps.setString(18, toJson(call.response() != null ? call.response().headers() : null));
        ps.setString(19, call.response() != null ? call.response().body() : null);
        ps.setString(20, haystack);
    }

    public boolean removeById(String cycleId, String capturedCallId) {
        return jdbcTemplate.update("DELETE FROM captured_calls WHERE cycle_id = ? AND id = ?", cycleId, capturedCallId) > 0;
    }

    public int removeByIds(String cycleId, List<String> capturedCallIds) {
        if (capturedCallIds.isEmpty()) {
            return 0;
        }
        String placeholders = String.join(",", capturedCallIds.stream().map(id -> "?").toList());
        List<Object> params = new java.util.ArrayList<>();
        params.add(cycleId);
        params.addAll(capturedCallIds);
        return jdbcTemplate.update("DELETE FROM captured_calls WHERE cycle_id = ? AND id IN (" + placeholders + ")", params.toArray());
    }

    public void deleteAllForCycle(String cycleId) {
        jdbcTemplate.update("DELETE FROM captured_calls WHERE cycle_id = ?", cycleId);
    }

    public Optional<CapturedCall> findByCallId(String cycleId, String callId) {
        return jdbcTemplate.query("SELECT * FROM captured_calls WHERE cycle_id = ? AND call_id = ?", CAPTURED_ROW_MAPPER, cycleId, callId)
                .stream().findFirst();
    }

    public boolean cycleHasAnyCapturedCalls(String cycleId) {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM captured_calls WHERE cycle_id = ?", Integer.class, cycleId);
        return result != null && result > 0;
    }

    /** See SqliteCallsRepository.SUMMARY_SQL's identical comment - list/search views never need request/response bodies. */
    private static final String SUMMARY_SQL =
            "SELECT id, captured_at, call_id, original_url, url, method, timestamp, duration_ms, status, error, supplier_name FROM ";

    public CallListSupport.Page<CapturedCallSummary> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        String supplierFilter = supplier == null ? "" : supplier.trim();

        StringBuilder where = new StringBuilder(" WHERE captured_calls.cycle_id = ?");
        List<Object> params = new java.util.ArrayList<>();
        params.add(cycleId);
        boolean useFts = ftsAvailable && !query.isEmpty();
        String fromClause = "captured_calls";
        if (useFts) {
            fromClause = "captured_calls JOIN captured_calls_fts ON captured_calls.rowid = captured_calls_fts.rowid";
            where.append(" AND captured_calls_fts MATCH ?");
            params.add(ftsQuery(query));
        } else if (!query.isEmpty()) {
            where.append(" AND captured_calls.haystack LIKE ?");
            params.add("%" + query + "%");
        }
        if (!supplierFilter.isEmpty()) {
            where.append(" AND captured_calls.supplier = ?");
            params.add(supplierFilter);
        }

        int total = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM " + fromClause + where, Integer.class, params.toArray());

        String orderBy = orderByFor(sort);
        int effectiveLimit = Math.max(limit, 0);
        int effectiveOffset = paginationEnabled ? Math.max(offset, 0) : 0;

        List<Object> pageParams = new java.util.ArrayList<>(params);
        pageParams.add(effectiveLimit);
        pageParams.add(effectiveOffset);

        List<CapturedCallSummary> items = jdbcTemplate.query(
                SUMMARY_SQL + fromClause + where + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?",
                SUMMARY_ROW_MAPPER, pageParams.toArray());

        return new CallListSupport.Page<>(items, total);
    }

    private static String orderByFor(String sort) {
        String mode = sort == null ? "newest" : sort;
        return switch (mode) {
            case "oldest" -> "captured_calls.rowid ASC";
            case "oldest-call" -> "captured_calls.timestamp_millis ASC";
            case "newest-call" -> "captured_calls.timestamp_millis DESC";
            case "slowest" -> "COALESCE(captured_calls.duration_ms, -1) DESC";
            case "fastest" -> "COALESCE(captured_calls.duration_ms, 1e18) ASC";
            case "status" -> "captured_calls.status_rank DESC";
            default -> "captured_calls.rowid DESC";
        };
    }

    private static String ftsQuery(String query) {
        return "\"" + query.replace("\"", "\"\"") + "\"";
    }

    private static int statusRank(CallRecord call) {
        if (call.error() != null && !call.error().isBlank()) {
            return 999;
        }
        Integer status = call.response() != null ? call.response().status() : null;
        return status == null ? -1 : status;
    }

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

    /** See SqliteCallsRepository.MAX_HAYSTACK_LENGTH's comment - caps FTS indexing cost for large captured-call bodies on the capture-fan-out hot path. */
    private static final int MAX_HAYSTACK_LENGTH = 20_000;

    private static String buildHaystack(CallRecord call) {
        StringBuilder sb = new StringBuilder();
        append(sb, call.method());
        append(sb, call.originalUrl());
        append(sb, call.url());
        if (call.response() != null) {
            sb.append(call.response().status()).append(' ');
            if (call.response().headers() != null) {
                sb.append(call.response().headers()).append(' ');
            }
            append(sb, call.response().body());
        }
        append(sb, call.error());
        if (call.request() != null) {
            if (call.request().headers() != null) {
                sb.append(call.request().headers()).append(' ');
            }
            append(sb, call.request().body());
        }
        String haystack = sb.toString().toLowerCase(Locale.ROOT);
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

    private final RowMapper<SessionCycle> CYCLE_ROW_MAPPER = (rs, rowNum) -> new SessionCycle(
            rs.getString("id"), rs.getString("name"), rs.getString("created_at"),
            rs.getString("assigned_to"), SessionCycleStatus.valueOf(rs.getString("status")));

    private final RowMapper<CapturedCall> CAPTURED_ROW_MAPPER = (rs, rowNum) -> {
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

        CallRecord call = new CallRecord(
                rs.getString("call_id"), rs.getString("original_url"), rs.getString("url"), rs.getString("method"),
                request, rs.getString("timestamp"), durationMs, response, rs.getString("error"));

        return new CapturedCall(rs.getString("id"), rs.getString("captured_at"), call);
    };

    private static final RowMapper<CapturedCallSummary> SUMMARY_ROW_MAPPER = (rs, rowNum) -> {
        Object statusObj = rs.getObject("status");
        Integer status = statusObj == null ? null : rs.getInt("status");
        Object durationObj = rs.getObject("duration_ms");
        Double durationMs = durationObj == null ? null : rs.getDouble("duration_ms");

        CallSummary callSummary = new CallSummary(
                rs.getString("call_id"),
                rs.getString("original_url"),
                rs.getString("url"),
                rs.getString("method"),
                rs.getString("timestamp"),
                durationMs,
                status,
                rs.getString("error"),
                nullIfEmpty(rs.getString("supplier_name")));

        return new CapturedCallSummary(rs.getString("id"), rs.getString("captured_at"), callSummary);
    };

    /** See SqliteCallsRepository's identical method - undoes the ""-instead-of-NULL storage trick so external behavior is unchanged. */
    private static String nullIfEmpty(String value) {
        return (value == null || value.isEmpty()) ? null : value;
    }

    /** Used only by the startup migrator, mirroring FileCallLogAdapter/JsonFileCapturedCallsStoreAdapter's own id-backfill rule. */
    public static CallRecord withGeneratedIdIfMissing(CallRecord call) {
        return call.id() != null ? call : new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(),
                call.method(), call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }
}
