package com.fathy.alfred.backend.triage.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.triage.application.port.out.AttentionStorePort;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.SoftFailure;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * triage.db - one row per call (call_attention), its own SQLite file like every other slice's. Every read goes through
 * an index; the partial ones hold only what triage asks for:
 *
 * <ul>
 *   <li>{@code ix_attention_recent} / {@code ix_attention_project} - calls with no parent at priority 5 or better, by
 *       start time (overall / per project): the live triage window</li>
 *   <li>{@code ix_attention_parent} - the supplier calls of a call</li>
 *   <li>{@code ix_attention_progress} - calls still IN_PROGRESS (a hung call is caught without scanning the rest)</li>
 *   <li>{@code ix_attention_started} - time windows for the counts, and the oldest rows for the row cap</li>
 * </ul>
 * SQLite only: like backend-db-capture and backend-logs, a per-call index over tens of thousands of rows has no
 * flat-file equivalent worth keeping.
 */
@Component
public class SqliteAttentionRepository implements AttentionStorePort {

    private static final int IN_CHUNK = 400;
    private static final TypeReference<List<String>> STRINGS = new TypeReference<>() { };
    /** The literal the partial indexes are built with - a query must repeat it word for word to use them. */
    static final int INDEXED_MAX_PRIORITY = 5;

    private static final String COLUMNS = "call_id, direction, project, parent_call_id, method, url, status, error, started_at, duration_ms, "
            + "state, soft_kind, soft_code, soft_message, empty_keys, failing_children, failed_statements, swallowed_statements, priority";

    private final ObjectMapper objectMapper;

    @Value("${TRIAGE_DB_FILE:/appdata/triage.db}")
    private String dbFile;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbcTemplate;

    public SqliteAttentionRepository(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
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
        // Every pragma in the URL, never a compound connectionInitSql (the driver runs only its first statement - see
        // SqliteDbCaptureRepository).
        config.setJdbcUrl("jdbc:sqlite:" + path + "?journal_mode=WAL&synchronous=NORMAL&busy_timeout=30000");
        config.setMaximumPoolSize(4);
        config.setPoolName("triage-sqlite-pool");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);
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
                CREATE TABLE IF NOT EXISTS call_attention (
                  call_id TEXT PRIMARY KEY, direction TEXT NOT NULL, project TEXT, parent_call_id TEXT,
                  method TEXT, url TEXT, status INTEGER, error TEXT, started_at INTEGER NOT NULL, duration_ms REAL,
                  state TEXT NOT NULL, soft_kind TEXT, soft_code TEXT, soft_message TEXT, empty_keys TEXT,
                  failing_children INTEGER NOT NULL DEFAULT 0, failed_statements INTEGER NOT NULL DEFAULT 0,
                  swallowed_statements INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL, updated_at INTEGER NOT NULL
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_attention_recent ON call_attention(started_at) "
                + "WHERE parent_call_id IS NULL AND priority <= " + INDEXED_MAX_PRIORITY);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_attention_project ON call_attention(project, started_at) "
                + "WHERE parent_call_id IS NULL AND priority <= " + INDEXED_MAX_PRIORITY);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_attention_parent ON call_attention(parent_call_id) WHERE parent_call_id IS NOT NULL");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_attention_progress ON call_attention(started_at) WHERE state = 'IN_PROGRESS'");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_attention_started ON call_attention(started_at)");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS triage_markers (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }

    // ------------------------------------------------------------------ reads

    private final RowMapper<CallAttention> mapper = this::map;

    private CallAttention map(ResultSet rs, int n) throws SQLException {
        String softKind = rs.getString("soft_kind");
        String emptyKeys = rs.getString("empty_keys");
        return new CallAttention(rs.getString("call_id"), CallDirection.valueOf(rs.getString("direction")), rs.getString("project"),
                rs.getString("parent_call_id"), rs.getString("method"), rs.getString("url"), nullableInt(rs, "status"),
                rs.getString("error"), rs.getLong("started_at"), nullableDouble(rs, "duration_ms"), rs.getString("state"),
                softKind == null ? null : new SoftFailure(softKind, rs.getString("soft_code"), rs.getString("soft_message")),
                emptyKeys == null ? List.of() : read(emptyKeys), rs.getInt("failing_children"), rs.getInt("failed_statements"),
                rs.getInt("swallowed_statements"), rs.getInt("priority"));
    }

    private static Integer nullableInt(ResultSet rs, String column) throws SQLException {
        int value = rs.getInt(column);
        return rs.wasNull() ? null : value;
    }

    private static Double nullableDouble(ResultSet rs, String column) throws SQLException {
        double value = rs.getDouble(column);
        return rs.wasNull() ? null : value;
    }

    @Override
    public Optional<CallAttention> find(String callId) {
        return jdbcTemplate.query("SELECT " + COLUMNS + " FROM call_attention WHERE call_id = ? LIMIT 1", mapper, callId).stream().findFirst();
    }

    @Override
    public List<CallAttention> findAll(Collection<String> callIds) {
        return inChunks(callIds, (in, args) -> jdbcTemplate.query(
                "SELECT " + COLUMNS + " FROM call_attention WHERE call_id IN (" + in + ")", mapper, args));
    }

    @Override
    public List<CallAttention> children(Collection<String> parentIds) {
        return inChunks(parentIds, (in, args) -> jdbcTemplate.query(
                "SELECT " + COLUMNS + " FROM call_attention INDEXED BY ix_attention_parent WHERE parent_call_id IS NOT NULL AND parent_call_id IN (" + in + ")", mapper, args));
    }

    @Override
    public List<CallAttention> live(String project, long since, long to, int maxPriority, long staleBefore, int limit) {
        String scope = project == null ? "" : " AND project = ?";
        String index = project == null ? "ix_attention_recent" : "ix_attention_project";
        List<Object> args = new ArrayList<>();
        if (project != null) {
            args.add(project);
        }
        args.add(since);
        args.add(to);
        List<Object> ranked = new ArrayList<>(args);
        ranked.add(Math.min(maxPriority, INDEXED_MAX_PRIORITY));
        ranked.add(limit);
        List<CallAttention> rows = new ArrayList<>();
        if (maxPriority > INDEXED_MAX_PRIORITY) {
            // Every call of the window: no partial index holds priority 6, so the time index serves it.
            rows.addAll(jdbcTemplate.query("SELECT " + COLUMNS + " FROM call_attention INDEXED BY ix_attention_started WHERE parent_call_id IS NULL"
                    + scope + " AND started_at BETWEEN ? AND ? ORDER BY started_at DESC LIMIT ?", mapper, withLimit(args, limit)));
        } else {
            rows.addAll(jdbcTemplate.query("SELECT " + COLUMNS + " FROM call_attention INDEXED BY " + index + " WHERE parent_call_id IS NULL"
                    + scope + " AND started_at BETWEEN ? AND ? AND priority <= " + INDEXED_MAX_PRIORITY + " AND priority <= ?"
                    + " ORDER BY started_at DESC LIMIT ?", mapper, ranked.toArray()));
        }
        // A call still running long after it should have finished needs attention whatever its stored priority.
        List<Object> stale = new ArrayList<>(args.subList(project == null ? 0 : 1, args.size()));
        stale.add(staleBefore);
        if (project != null) {
            stale.add(project);
        }
        stale.add(limit);
        rows.addAll(jdbcTemplate.query("SELECT " + COLUMNS + " FROM call_attention INDEXED BY ix_attention_progress WHERE state = 'IN_PROGRESS'"
                + " AND started_at BETWEEN ? AND ? AND started_at < ? AND parent_call_id IS NULL" + scope
                + " ORDER BY started_at DESC LIMIT ?", mapper, stale.toArray()));
        Map<String, CallAttention> unique = new LinkedHashMap<>();
        rows.forEach(r -> unique.putIfAbsent(r.callId(), r));
        return unique.values().stream().sorted(Comparator.comparingLong(CallAttention::startedAt).reversed()).limit(limit).toList();
    }

    private static Object[] withLimit(List<Object> args, int limit) {
        List<Object> all = new ArrayList<>(args);
        all.add(limit);
        return all.toArray();
    }

    @Override
    public Map<Integer, Integer> counts(String project, long since, long to) {
        Map<Integer, Integer> counts = new LinkedHashMap<>();
        String sql = "SELECT priority, COUNT(*) AS n FROM call_attention INDEXED BY ix_attention_started WHERE started_at BETWEEN ? AND ?"
                + " AND parent_call_id IS NULL" + (project == null ? "" : " AND project = ?") + " GROUP BY priority";
        Object[] args = project == null ? new Object[]{since, to} : new Object[]{since, to, project};
        jdbcTemplate.query(sql, rs -> {
            counts.put(rs.getInt("priority"), rs.getInt("n"));
        }, args);
        return counts;
    }

    @Override
    public long size() {
        Long n = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM call_attention", Long.class);
        return n == null ? 0 : n;
    }

    // ------------------------------------------------------------------ writes

    @Override
    public void save(CallAttention row) {
        SoftFailure soft = row.softFailure();
        jdbcTemplate.update("""
                INSERT INTO call_attention (call_id, direction, project, parent_call_id, method, url, status, error, started_at, duration_ms,
                  state, soft_kind, soft_code, soft_message, empty_keys, failing_children, failed_statements, swallowed_statements, priority, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(call_id) DO UPDATE SET direction = excluded.direction, project = excluded.project,
                  parent_call_id = excluded.parent_call_id, method = excluded.method, url = excluded.url, status = excluded.status,
                  error = excluded.error, started_at = excluded.started_at, duration_ms = excluded.duration_ms, state = excluded.state,
                  soft_kind = excluded.soft_kind, soft_code = excluded.soft_code, soft_message = excluded.soft_message,
                  empty_keys = excluded.empty_keys, failing_children = excluded.failing_children,
                  failed_statements = excluded.failed_statements, swallowed_statements = excluded.swallowed_statements,
                  priority = excluded.priority, updated_at = excluded.updated_at
                """,
                row.callId(), row.direction().name(), row.project(), row.parentCallId(), row.method(), row.url(), row.status(), row.error(),
                row.startedAt(), row.durationMs(), row.state(), soft == null ? null : soft.kind(), soft == null ? null : soft.code(),
                soft == null ? null : soft.message(), row.emptyKeys().isEmpty() ? null : json(row.emptyKeys()), row.failingChildren(),
                row.failedStatements(), row.swallowedStatements(), row.priority(), Instant.now().toEpochMilli());
    }

    @Override
    public int deleteOldest(int count, Set<String> keep) {
        if (count <= 0) {
            return 0;
        }
        List<String> victims = new ArrayList<>();
        int offset = 0;
        int page = Math.max(count * 2, 500);
        while (victims.size() < count) {
            List<String> ids = jdbcTemplate.queryForList("SELECT call_id FROM call_attention INDEXED BY ix_attention_started ORDER BY started_at LIMIT ? OFFSET ?",
                    String.class, page, offset);
            if (ids.isEmpty()) {
                break;
            }
            for (String id : ids) {
                if (!keep.contains(id) && victims.size() < count) {
                    victims.add(id);
                }
            }
            offset += ids.size();
        }
        return inChunks(victims, (in, args) -> List.of(jdbcTemplate.update("DELETE FROM call_attention WHERE call_id IN (" + in + ")", args)))
                .stream().mapToInt(Integer::intValue).sum();
    }

    @Override
    public boolean hasMarker(String key) {
        return !jdbcTemplate.queryForList("SELECT value FROM triage_markers WHERE key = ?", String.class, key).isEmpty();
    }

    @Override
    public void setMarker(String key, String value) {
        jdbcTemplate.update("INSERT INTO triage_markers (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    }

    // ------------------------------------------------------------------ helpers

    private interface ChunkQuery<T> {
        List<T> run(String placeholders, Object[] args);
    }

    private static <T> List<T> inChunks(Collection<String> values, ChunkQuery<T> query) {
        List<String> ids = values.stream().filter(v -> v != null && !v.isBlank()).distinct().toList();
        List<T> result = new ArrayList<>();
        for (int i = 0; i < ids.size(); i += IN_CHUNK) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + IN_CHUNK));
            result.addAll(query.run(chunk.stream().map(x -> "?").collect(Collectors.joining(",")), chunk.toArray()));
        }
        return result;
    }

    private String json(List<String> value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private List<String> read(String json) {
        try {
            return objectMapper.readValue(json, STRINGS);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
