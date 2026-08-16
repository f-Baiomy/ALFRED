package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.adapter.out.sqlite.BatchWriter;
import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Owns every raw SQL/JDBC detail for session-cycles.db - both the session_cycles metadata table
 * and captured-call storage (one shared file, not one file per cycle the way the JSON adapter
 * worked - see the migration plan). SqliteSessionCycleMetadataStoreAdapter and
 * SqliteCapturedCallsStoreAdapter are thin wrappers that implement their respective ports purely
 * by delegating here, mirroring backend-calls' SqliteCallsRepository/SqliteCallLogAdapter split.
 *
 * <p>Captured-call storage is split across three tables rather than one wide row, mirroring
 * SqliteCallsRepository's own {@code call_metadata}/{@code call_request}/{@code call_response}
 * split: {@code captured_call_metadata} (every column {@link #query}/search/sort ever touch -
 * keyed by the captured-call's own id, since the same underlying call can be captured into
 * multiple cycles as independent rows), {@code captured_call_request}, and
 * {@code captured_call_response} (one row each, linked by {@code captured_call_id}, holding only
 * headers/body). Both payload tables get a row the moment a call is {@link #append}ed - blank for
 * an in-progress call, filled in immediately for an already-resolved one - and
 * {@link #completeCapturedCall} just {@code UPDATE}s the existing rows. {@code ON DELETE CASCADE}
 * (with {@code PRAGMA foreign_keys=true}, see the connection URL below) means every removal path
 * only ever needs to delete from {@code captured_call_metadata}.
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
    private BatchWriter<PendingCapturedCall> insertWriter;
    private BatchWriter<PendingCapturedCallCompletion> completionWriter;

    /** cycleId travels alongside the CapturedCall since captured_call_metadata's INSERT needs it bound too - BatchWriter is generic over one item type, so this pairs them for the batch. */
    private record PendingCapturedCall(String cycleId, CapturedCall captured) {}

    /** The outcome half of a two-phase captured call, awaiting write via {@link #completionWriter} - see {@link #completeCapturedCall}. */
    private record PendingCapturedCallCompletion(String cycleId, String callId, ResponseData response, String error, Double durationMs) {}

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
        // See SqliteCallsRepository's identical comment: a semicolon-joined connectionInitSql
        // string only reliably applies its *first* pragma with this SQLite JDBC driver (verified
        // empirically) - busy_timeout/foreign_keys never actually took effect past journal_mode.
        // The driver's own URL query-parameter syntax applies all of them correctly on every
        // connection instead. A 10s busy_timeout means a second concurrent writer waits for the
        // first to finish instead of failing outright (the original SQLITE_BUSY drop bug this was
        // meant to fix), and foreign_keys=true is what makes every removal path's cascade-delete of
        // captured_call_request/captured_call_response actually happen.
        config.setJdbcUrl("jdbc:sqlite:" + path + "?journal_mode=WAL&synchronous=NORMAL&busy_timeout=10000&foreign_keys=true");
        config.setMaximumPoolSize(20);
        config.setPoolName("session-cycles-sqlite-pool");
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

        createCapturedCallSchema();
        initFts();

        // Group-commit writer for captured calls - see SqliteCallsRepository's identical field for
        // why this eliminates cross-request lock contention on session-cycles.db. Statement order
        // matters: captured_call_metadata must be inserted before captured_call_request/
        // captured_call_response (both FK-reference it), and BatchWriter runs one statement across
        // the whole batch before moving to the next, so every item's metadata row lands before any
        // item's payload rows regardless of batch size.
        this.insertWriter = new BatchWriter<>("session-cycles-sqlite-writer", dataSource, List.of(
                new BatchWriter.StatementSpec<>(INSERT_METADATA_SQL, this::bindMetadata),
                new BatchWriter.StatementSpec<>(INSERT_REQUEST_SQL, this::bindRequest),
                new BatchWriter.StatementSpec<>(INSERT_RESPONSE_SQL, this::bindResponseFromCaptured)
        ), 1000);
        // A second, independent writer for the two-phase "complete" UPDATEs - same rationale as
        // insertWriter, mirroring SqliteCallsRepository's own completionWriter.
        this.completionWriter = new BatchWriter<>("session-cycles-sqlite-completion-writer", dataSource, List.of(
                new BatchWriter.StatementSpec<>(UPDATE_METADATA_SQL, this::bindCompletionMetadata),
                new BatchWriter.StatementSpec<>(UPDATE_RESPONSE_SQL, this::bindCompletionResponse)
        ), 1000);

        migrateLegacySingleTableIfPresent();
    }

    private void createCapturedCallSchema() {
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS captured_call_metadata (
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
                  haystack TEXT,
                  status_state TEXT NOT NULL DEFAULT 'COMPLETED',
                  request_haystack TEXT,
                  session_id TEXT,
                  operation_id TEXT
                )
                """);
        addSessionOperationColumnsIfMissing();
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS captured_call_request (
                  captured_call_id TEXT PRIMARY KEY REFERENCES captured_call_metadata(id) ON DELETE CASCADE,
                  headers TEXT,
                  body TEXT
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS captured_call_response (
                  captured_call_id TEXT PRIMARY KEY REFERENCES captured_call_metadata(id) ON DELETE CASCADE,
                  headers TEXT,
                  body TEXT
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_captured_call_metadata_cycle ON captured_call_metadata(cycle_id)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_captured_call_metadata_timestamp ON captured_call_metadata(cycle_id, timestamp_millis)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_captured_call_metadata_call_id ON captured_call_metadata(call_id)");
    }

    /** See SqliteCallsRepository's identical method - session_id/operation_id were added after captured_call_metadata was already in use in some deployments. */
    private void addSessionOperationColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(captured_call_metadata)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("session_id")) {
            jdbcTemplate.execute("ALTER TABLE captured_call_metadata ADD COLUMN session_id TEXT");
        }
        if (!columns.contains("operation_id")) {
            jdbcTemplate.execute("ALTER TABLE captured_call_metadata ADD COLUMN operation_id TEXT");
        }
    }

    private void initFts() {
        try {
            jdbcTemplate.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS captured_calls_fts USING fts5(
                      haystack, content='captured_call_metadata', content_rowid='rowid', tokenize='trigram'
                    )
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS captured_call_metadata_ai AFTER INSERT ON captured_call_metadata BEGIN
                      INSERT INTO captured_calls_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS captured_call_metadata_ad AFTER DELETE ON captured_call_metadata BEGIN
                      INSERT INTO captured_calls_fts(captured_calls_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
                    END
                    """);
            jdbcTemplate.execute("""
                    CREATE TRIGGER IF NOT EXISTS captured_call_metadata_au AFTER UPDATE ON captured_call_metadata BEGIN
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

    /**
     * One-time, safely-rerunnable migration from the pre-split single {@code captured_calls} table
     * into the new 3-table shape - skipped if {@code captured_calls} doesn't exist, or if
     * {@code captured_call_metadata} already has rows. Normalizes the legacy table's own shape
     * first (the same supplier_name/lifecycle-column backfills this repository always used to do
     * against it), then re-persists each row through {@link #insert} - preserving the row's
     * original id (not {@link #append}, which would mint a new one) since removeById/findByCallId
     * and any external reference (comments, exports already run) key on it. The legacy table is
     * renamed (never dropped) to {@code captured_calls_legacy} afterward, kept as a safety-net backup.
     */
    private void migrateLegacySingleTableIfPresent() {
        boolean legacyTableExists = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'captured_calls'", Integer.class) > 0;
        if (!legacyTableExists || capturedCallsCountAll() > 0) {
            return;
        }

        addLegacySupplierNameColumnIfMissing();
        addLegacyLifecycleColumnsIfMissing();
        addLegacySessionOperationColumnsIfMissing();

        int migrated = 0;
        List<PendingCapturedCall> legacyRows = jdbcTemplate.query("SELECT * FROM captured_calls ORDER BY rowid ASC", LEGACY_ROW_MAPPER);
        for (PendingCapturedCall pending : legacyRows) {
            insert(pending.cycleId(), pending.captured());
            migrated++;
        }

        jdbcTemplate.execute("ALTER TABLE captured_calls RENAME TO captured_calls_legacy");
        log.info("Migrated {} captured call(s) from the legacy single-table session-cycles.db shape into captured_call_metadata/captured_call_request/captured_call_response; renamed captured_calls to captured_calls_legacy", migrated);
    }

    private void addLegacySupplierNameColumnIfMissing() {
        boolean alreadyPresent = jdbcTemplate.query("PRAGMA table_info(captured_calls)",
                        (rs, rowNum) -> rs.getString("name"))
                .stream().anyMatch("supplier_name"::equals);
        if (!alreadyPresent) {
            jdbcTemplate.execute("ALTER TABLE captured_calls ADD COLUMN supplier_name TEXT");
        }
    }

    private void addLegacyLifecycleColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(captured_calls)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("status_state")) {
            jdbcTemplate.execute("ALTER TABLE captured_calls ADD COLUMN status_state TEXT NOT NULL DEFAULT 'COMPLETED'");
            jdbcTemplate.update("UPDATE captured_calls SET status_state = 'ERROR' WHERE error IS NOT NULL AND error != ''");
        }
        if (!columns.contains("request_haystack")) {
            jdbcTemplate.execute("ALTER TABLE captured_calls ADD COLUMN request_haystack TEXT");
        }
    }

    /** See SqliteCallsRepository's identical method - session_id/operation_id postdate even the single-table captured_calls schema. */
    private void addLegacySessionOperationColumnsIfMissing() {
        List<String> columns = jdbcTemplate.query("PRAGMA table_info(captured_calls)", (rs, rowNum) -> rs.getString("name"));
        if (!columns.contains("session_id")) {
            jdbcTemplate.execute("ALTER TABLE captured_calls ADD COLUMN session_id TEXT");
        }
        if (!columns.contains("operation_id")) {
            jdbcTemplate.execute("ALTER TABLE captured_calls ADD COLUMN operation_id TEXT");
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

    /** Bytes currently on disk for session-cycles.db - drives the Database settings tab's file-size table. Returns 0 if the file doesn't exist yet rather than throwing. */
    public long storageSizeBytes() {
        try {
            return Files.size(Path.of(dbFile));
        } catch (IOException e) {
            return 0L;
        }
    }

    /** Deletes every session cycle - the Database settings tab's "Clear cycles" action deletes cycles and captured calls together (see deleteAllCapturedCalls()). */
    public void deleteAllCycles() {
        jdbcTemplate.update("DELETE FROM session_cycles");
    }

    /** Deletes every captured call across every cycle - deleting from captured_call_metadata cascades to captured_call_request/captured_call_response, and captured_calls_fts stays in sync via its external-content triggers. */
    public void deleteAllCapturedCalls() {
        jdbcTemplate.update("DELETE FROM captured_call_metadata");
        try {
            jdbcTemplate.execute("VACUUM");
        } catch (Exception e) {
            log.warn("VACUUM after clearing session-cycles.db failed (non-fatal): {}", e.getMessage());
        }
    }

    // ---------- captured calls ----------

    private static final String DETAIL_JOIN_SQL = """
            SELECT cm.id, cm.cycle_id, cm.captured_at, cm.call_id, cm.original_url, cm.url, cm.method,
                   cm.timestamp, cm.duration_ms, cm.status, cm.error, cm.status_state,
                   cm.session_id, cm.operation_id,
                   cr.headers AS request_headers, cr.body AS request_body,
                   cp.headers AS response_headers, cp.body AS response_body
            FROM captured_call_metadata cm
            LEFT JOIN captured_call_request cr ON cr.captured_call_id = cm.id
            LEFT JOIN captured_call_response cp ON cp.captured_call_id = cm.id
            """;

    public List<CapturedCall> findAllByCycle(String cycleId) {
        return jdbcTemplate.query(DETAIL_JOIN_SQL + " WHERE cm.cycle_id = ? ORDER BY cm.rowid ASC", CAPTURED_ROW_MAPPER, cycleId);
    }

    /** Inserts a captured call - used both for an already-resolved call (legacy/file-parity path) and for the first half of two-phase capture (call.state() == IN_PROGRESS, response/error/durationMs null). */
    public CapturedCall append(String cycleId, CallRecord call) {
        CapturedCall captured = new CapturedCall(UUID.randomUUID().toString(), Instant.now().toString(), call);
        insert(cycleId, captured);
        return captured;
    }

    /** Blocks until actually committed (all 3 tables) - see BatchWriter's class doc. */
    void insert(String cycleId, CapturedCall captured) {
        insertWriter.submit(new PendingCapturedCall(cycleId, captured));
    }

    private static final String INSERT_METADATA_SQL = """
            INSERT INTO captured_call_metadata (id, cycle_id, captured_at, call_id, original_url, url, method,
                                 timestamp, timestamp_millis, duration_ms, status, status_rank,
                                 supplier, supplier_name, error, haystack, status_state, request_haystack,
                                 session_id, operation_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """;

    private static final String INSERT_REQUEST_SQL = "INSERT INTO captured_call_request (captured_call_id, headers, body) VALUES (?,?,?)";

    private static final String INSERT_RESPONSE_SQL = "INSERT INTO captured_call_response (captured_call_id, headers, body) VALUES (?,?,?)";

    /** Binds one pending captured call's metadata-table columns - runs on insertWriter's single dedicated thread. */
    private void bindMetadata(PreparedStatement ps, PendingCapturedCall pending) throws SQLException {
        String cycleId = pending.cycleId();
        CapturedCall captured = pending.captured();
        CallRecord call = CallRecord.withDerivedStateIfMissing(captured.call());
        String requestHaystack = buildRequestHaystack(call);
        String haystack = buildHaystack(call, requestHaystack);
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
        ps.setInt(12, statusRank(call.response(), call.error()));
        ps.setString(13, CallListSupport.supplierOf(call));
        // Precomputed here (not derived from request_body on every read) so list/search queries
        // can skip fetching request_body entirely - see query()'s SUMMARY_SQL. Stored as "" rather
        // than SQL NULL when there's genuinely no supplier field, for consistency with how this
        // value has always round-tripped (see nullIfEmpty).
        String supplierName = CallSummary.supplierNameOf(call);
        ps.setString(14, supplierName == null ? "" : supplierName);
        ps.setString(15, call.error());
        ps.setString(16, haystack);
        ps.setString(17, call.state().name());
        ps.setString(18, requestHaystack);
        ps.setString(19, call.sessionId());
        ps.setString(20, call.operationId());
    }

    /** Binds one pending captured call's request-table row - always inserted (headers/body null if there is no request data). */
    private void bindRequest(PreparedStatement ps, PendingCapturedCall pending) throws SQLException {
        RequestData request = pending.captured().call().request();
        ps.setString(1, pending.captured().id());
        ps.setString(2, toJson(request != null ? request.headers() : null));
        ps.setString(3, request != null ? request.body() : null);
    }

    /** Binds one pending captured call's response-table row at insert time - null headers/body for a still-in-progress call (filled in later by {@link #completeCapturedCall}), already-populated for a call that arrived already resolved. */
    private void bindResponseFromCaptured(PreparedStatement ps, PendingCapturedCall pending) throws SQLException {
        ResponseData response = pending.captured().call().response();
        ps.setString(1, pending.captured().id());
        ps.setString(2, toJson(response != null ? response.headers() : null));
        ps.setString(3, response != null ? response.body() : null);
    }

    private static final String UPDATE_METADATA_SQL = """
            UPDATE captured_call_metadata SET
              status = ?, status_rank = ?, error = ?, duration_ms = ?, status_state = ?,
              haystack = substr(COALESCE(request_haystack, '') || ' ' || ?, 1, ?)
            WHERE cycle_id = ? AND call_id = ?
            """;

    private static final String UPDATE_RESPONSE_SQL = """
            UPDATE captured_call_response SET headers = ?, body = ?
            WHERE captured_call_id = (SELECT id FROM captured_call_metadata WHERE cycle_id = ? AND call_id = ?)
            """;

    /** Second half of two-phase capture - fills in a previously-{@link #append}ed captured call's outcome, scoped to one cycle (SessionCycleCaptureAdapter calls this once per cycle it captured the call into at prepare time). @return true if a matching row existed. */
    public boolean completeCapturedCall(String cycleId, String callId, ResponseData response, String error, Double durationMs) {
        Integer existing = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM captured_call_metadata WHERE cycle_id = ? AND call_id = ?", Integer.class, cycleId, callId);
        if (existing == null || existing == 0) {
            return false;
        }
        completionWriter.submit(new PendingCapturedCallCompletion(cycleId, callId, response, error, durationMs));
        return true;
    }

    private void bindCompletionMetadata(PreparedStatement ps, PendingCapturedCallCompletion pending) throws SQLException {
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
        ps.setString(8, pending.cycleId());
        ps.setString(9, pending.callId());
    }

    private void bindCompletionResponse(PreparedStatement ps, PendingCapturedCallCompletion pending) throws SQLException {
        ResponseData response = pending.response();
        ps.setString(1, toJson(response != null ? response.headers() : null));
        ps.setString(2, response != null ? response.body() : null);
        ps.setString(3, pending.cycleId());
        ps.setString(4, pending.callId());
    }

    public boolean removeById(String cycleId, String capturedCallId) {
        return jdbcTemplate.update("DELETE FROM captured_call_metadata WHERE cycle_id = ? AND id = ?", cycleId, capturedCallId) > 0;
    }

    public int removeByIds(String cycleId, List<String> capturedCallIds) {
        if (capturedCallIds.isEmpty()) {
            return 0;
        }
        String placeholders = String.join(",", capturedCallIds.stream().map(id -> "?").toList());
        List<Object> params = new ArrayList<>();
        params.add(cycleId);
        params.addAll(capturedCallIds);
        return jdbcTemplate.update("DELETE FROM captured_call_metadata WHERE cycle_id = ? AND id IN (" + placeholders + ")", params.toArray());
    }

    public void deleteAllForCycle(String cycleId) {
        jdbcTemplate.update("DELETE FROM captured_call_metadata WHERE cycle_id = ?", cycleId);
    }

    public Optional<CapturedCall> findByCallId(String cycleId, String callId) {
        return jdbcTemplate.query(DETAIL_JOIN_SQL + " WHERE cm.cycle_id = ? AND cm.call_id = ?", CAPTURED_ROW_MAPPER, cycleId, callId)
                .stream().findFirst();
    }

    public int capturedCallsCountAll() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM captured_call_metadata", Integer.class);
        return result == null ? 0 : result;
    }

    public boolean cycleHasAnyCapturedCalls(String cycleId) {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM captured_call_metadata WHERE cycle_id = ?", Integer.class, cycleId);
        return result != null && result > 0;
    }

    /** See SqliteCallsRepository.SUMMARY_SQL's identical comment - list/search views never need request/response bodies. */
    private static final String SUMMARY_SQL =
            "SELECT id, captured_at, call_id, original_url, url, method, timestamp, duration_ms, status, error, supplier_name, status_state, session_id, operation_id FROM ";

    public CallListSupport.Page<CapturedCallSummary> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        String supplierFilter = supplier == null ? "" : supplier.trim();

        StringBuilder where = new StringBuilder(" WHERE captured_call_metadata.cycle_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(cycleId);
        boolean useFts = ftsAvailable && !query.isEmpty();
        String fromClause = "captured_call_metadata";
        if (useFts) {
            fromClause = "captured_call_metadata JOIN captured_calls_fts ON captured_call_metadata.rowid = captured_calls_fts.rowid";
            where.append(" AND captured_calls_fts MATCH ?");
            params.add(ftsQuery(query));
        } else if (!query.isEmpty()) {
            where.append(" AND captured_call_metadata.haystack LIKE ?");
            params.add("%" + query + "%");
        }
        if (!supplierFilter.isEmpty()) {
            where.append(" AND captured_call_metadata.supplier = ?");
            params.add(supplierFilter);
        }

        int total = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM " + fromClause + where, Integer.class, params.toArray());

        String orderBy = orderByFor(sort);
        int effectiveLimit = Math.max(limit, 0);
        int effectiveOffset = paginationEnabled ? Math.max(offset, 0) : 0;

        List<Object> pageParams = new ArrayList<>(params);
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
            case "oldest" -> "captured_call_metadata.rowid ASC";
            case "oldest-call" -> "captured_call_metadata.timestamp_millis ASC";
            case "newest-call" -> "captured_call_metadata.timestamp_millis DESC";
            case "slowest" -> "COALESCE(captured_call_metadata.duration_ms, -1) DESC";
            case "fastest" -> "COALESCE(captured_call_metadata.duration_ms, 1e18) ASC";
            case "status" -> "captured_call_metadata.status_rank DESC";
            default -> "captured_call_metadata.rowid DESC";
        };
    }

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

    /** See SqliteCallsRepository's identical method - the request-only slice of the haystack, persisted in request_haystack so completeCapturedCall can extend it into the full mixed haystack purely in SQL. */
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

    /** See SqliteCallsRepository's identical method. */
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
                request, rs.getString("timestamp"), durationMs, response, rs.getString("error"),
                CallLifecycleStatus.valueOf(rs.getString("status_state")), rs.getString("session_id"), rs.getString("operation_id"));

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
                nullIfEmpty(rs.getString("supplier_name")),
                CallLifecycleStatus.valueOf(rs.getString("status_state")),
                rs.getString("session_id"), rs.getString("operation_id"));

        return new CapturedCallSummary(rs.getString("id"), rs.getString("captured_at"), callSummary);
    };

    /** Reads a row of the OLD (pre-split) single-table {@code captured_calls} shape - used only by {@link #migrateLegacySingleTableIfPresent}. */
    private static final RowMapper<PendingCapturedCall> LEGACY_ROW_MAPPER = (rs, rowNum) -> {
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

        CallRecord call = new CallRecord(
                rs.getString("call_id"), rs.getString("original_url"), rs.getString("url"), rs.getString("method"),
                request, rs.getString("timestamp"), durationMs, response, rs.getString("error"),
                CallLifecycleStatus.valueOf(rs.getString("status_state")), rs.getString("session_id"), rs.getString("operation_id"));

        CapturedCall captured = new CapturedCall(rs.getString("id"), rs.getString("captured_at"), call);
        return new PendingCapturedCall(rs.getString("cycle_id"), captured);
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
