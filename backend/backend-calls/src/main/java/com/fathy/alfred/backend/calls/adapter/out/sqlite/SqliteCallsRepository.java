package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
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
import java.sql.Connection;
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
    private BatchWriter<CallRecord> batchWriter;

    /** How often (in saves) to check the file size against maxSizeBytes - stat'ing the file on every single insert would itself be wasteful at high write volume. */
    private static final int SIZE_CHECK_EVERY_N_SAVES = 50;
    private int savesSinceLastSizeCheck;

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
                  error TEXT,
                  request_headers TEXT,
                  request_body TEXT,
                  response_headers TEXT,
                  response_body TEXT,
                  haystack TEXT
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_timestamp_millis ON calls(timestamp_millis)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_supplier ON calls(supplier)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_status_rank ON calls(status_rank)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_calls_duration ON calls(duration_ms)");

        initFts();

        // Group-commit writer: exactly one thread ever opens a write transaction against
        // calls.db, so concurrent webhook calls never contend for SQLite's single write lock with
        // each other, and a burst that arrives while a commit is in flight gets folded into the
        // next transaction instead of each paying for its own commit. See BatchWriter's own doc.
        this.batchWriter = new BatchWriter<>("calls-sqlite-writer", dataSource, this::insertBatch);
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

    @PreDestroy
    public void close() {
        if (batchWriter != null) {
            batchWriter.close();
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

    /** Blocks until the call is actually committed - see BatchWriter's class doc for why this is still synchronous (and safe under concurrency) despite writes now being batched. */
    public void save(CallRecord call) {
        batchWriter.submit(call);

        if (++savesSinceLastSizeCheck >= SIZE_CHECK_EVERY_N_SAVES) {
            savesSinceLastSizeCheck = 0;
            enforceRetention();
        }
    }

    private static final String INSERT_SQL = """
            INSERT INTO calls (id, original_url, url, method, timestamp, timestamp_millis, duration_ms,
                               status, status_rank, supplier, error, request_headers, request_body,
                               response_headers, response_body, haystack)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """;

    /** Runs on BatchWriter's single dedicated thread - executes every call in the batch as one JDBC batch, committed once by the caller. */
    private void insertBatch(Connection connection, List<CallRecord> batch) throws SQLException {
        try (PreparedStatement ps = connection.prepareStatement(INSERT_SQL)) {
            for (CallRecord call : batch) {
                String haystack = buildHaystack(call);
                Integer status = call.response() != null ? call.response().status() : null;
                ps.setString(1, call.id());
                ps.setString(2, call.originalUrl());
                ps.setString(3, call.url());
                ps.setString(4, call.method());
                ps.setString(5, call.timestamp());
                ps.setLong(6, callTimeMillis(call));
                if (call.durationMs() != null) {
                    ps.setDouble(7, call.durationMs());
                } else {
                    ps.setNull(7, Types.DOUBLE);
                }
                if (status != null) {
                    ps.setInt(8, status);
                } else {
                    ps.setNull(8, Types.INTEGER);
                }
                ps.setInt(9, statusRank(call));
                ps.setString(10, CallListSupport.supplierOf(call));
                ps.setString(11, call.error());
                ps.setString(12, toJson(call.request() != null ? call.request().headers() : null));
                ps.setString(13, call.request() != null ? call.request().body() : null);
                ps.setString(14, toJson(call.response() != null ? call.response().headers() : null));
                ps.setString(15, call.response() != null ? call.response().body() : null);
                ps.setString(16, haystack);
                ps.addBatch();
            }
            ps.executeBatch();
        }
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

    public CallListSupport.Page<CallRecord> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
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

        List<CallRecord> items = jdbcTemplate.query(
                "SELECT calls.* FROM " + fromClause + where + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?",
                ROW_MAPPER, pageParams.toArray());

        return new CallListSupport.Page<>(items, total);
    }

    public int count() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM calls", Integer.class);
        return result == null ? 0 : result;
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

    private static int statusRank(CallRecord call) {
        if (call.error() != null && !call.error().isBlank()) {
            return 999;
        }
        Integer status = call.response() != null ? call.response().status() : null;
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

    /** Mirrors CallListSupport.matchesSearch's haystack construction (method/urls/status/headers/error/bodies, lowercased), truncated to MAX_HAYSTACK_LENGTH before indexing. */
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
                rs.getString("error"));
    };

    /** Used only by the startup migrator so it never has to know a legacy line without an id needs one generated - same rule FileCallLogAdapter applies while it's still the active adapter. */
    public static CallRecord withGeneratedIdIfMissing(CallRecord call) {
        return call.id() != null ? call : new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(),
                call.method(), call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }
}
