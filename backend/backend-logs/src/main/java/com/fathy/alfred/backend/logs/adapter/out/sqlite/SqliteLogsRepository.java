package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Pattern;

/**
 * Owns logs.db: the pooled DataSource, the shared tables, and the per-source DDL (research §R2).
 * Each source gets its own tables because its fields are user data unknown at build time:
 * {@code ll_<id>} (one row per line; {@code f<N>} original text, {@code t<N>} typed value),
 * {@code fts_<id>} (trigram index over the Text-search fields), {@code lg_<id>} (group-node
 * aggregates for the grouped view), {@code lp_<id>} (pattern templates) and {@code ls_<id>} (the
 * structures found among the lines, with their counts, names and templates).
 *
 * <p>Table names are built only from server-generated source ids that match {@link #SOURCE_ID};
 * nothing a caller sends ever reaches DDL.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.logs", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteLogsRepository {

    static final Pattern SOURCE_ID = Pattern.compile("^s[0-9a-f]{12}$");

    @Value("${LOGS_DB_FILE:/appdata/logs.db}")
    private String dbFile;
    /** Where logs.db lived before it moved to its own volume; copied once if the new file does not exist yet. */
    @Value("${LOGS_DB_LEGACY_FILE:}")
    private String legacyFile;

    private HikariDataSource dataSource;
    private JdbcTemplate jdbcTemplate;

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
        migrateLegacy(path);
        HikariConfig config = new HikariConfig();
        // IMMEDIATE: a write transaction takes the write lock when it begins. A deferred one that reads
        // first (append checks which lines exist) and then writes fails at once with SQLITE_BUSY when
        // another writer committed in between - busy_timeout cannot help an upgrade.
        config.setJdbcUrl("jdbc:sqlite:" + path + "?transaction_mode=IMMEDIATE");
        // 6 connections: the explorer's parallel reads plus one writer. Each holds its own page cache
        // outside the Java heap, so the pool size multiplies the cache below.
        config.setMaximumPoolSize(6);
        config.setPoolName("logs-sqlite-pool");
        // Same per-connection PRAGMAs as SqliteReliveRepository (busy_timeout must be on every pooled
        // connection or concurrent writers get SQLITE_BUSY). cache_size/temp_store: the grouped and
        // histogram queries aggregate over millions of rows (16 MB per connection: 64 MB × 8 held ~0.5 GB of
        // native memory that never showed up in the heap). 30 s, not 10: one 5,000-line ingest batch
        // takes several seconds on a slow disk (Docker Desktop bind mount), and other writers queue behind it.
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=30000; "
                + "PRAGMA cache_size=-16384; PRAGMA temp_store=MEMORY;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS log_source (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  raw_mode TEXT NOT NULL,
                  privacy_mode TEXT NOT NULL,
                  retention_max_bytes INTEGER NOT NULL,
                  retention_max_days INTEGER NOT NULL,
                  line_count INTEGER NOT NULL DEFAULT 0,
                  stored_bytes INTEGER NOT NULL DEFAULT 0,
                  unparsed_count INTEGER NOT NULL DEFAULT 0,
                  structure_id TEXT,
                  structure_json TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS log_input (
                  id TEXT PRIMARY KEY,
                  source_id TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  path TEXT,
                  file_name TEXT,
                  fingerprint TEXT,
                  status TEXT NOT NULL,
                  status_reason TEXT,
                  position INTEGER NOT NULL DEFAULT 0,
                  lines_read INTEGER NOT NULL DEFAULT 0,
                  total_bytes INTEGER NOT NULL DEFAULT 0,
                  mismatch_count INTEGER NOT NULL DEFAULT 0,
                  unparsed_count INTEGER NOT NULL DEFAULT 0,
                  started_at TEXT,
                  updated_at TEXT
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_log_input_source ON log_input(source_id)");
        // Watched folders (2026-10-04): a WATCHED_FILE input belongs to its folder input; a WATCH input keeps its options.
        java.util.List<String> inputCols = jdbcTemplate.queryForList("SELECT name FROM pragma_table_info('log_input')", String.class);
        if (!inputCols.contains("parent_id")) {
            jdbcTemplate.execute("ALTER TABLE log_input ADD COLUMN parent_id TEXT");
        }
        if (!inputCols.contains("options")) {
            jdbcTemplate.execute("ALTER TABLE log_input ADD COLUMN options TEXT");
        }
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS log_session (
                  id TEXT PRIMARY KEY,
                  source_id TEXT NOT NULL,
                  json TEXT NOT NULL,
                  started_at INTEGER NOT NULL
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_log_session_source ON log_session(source_id, started_at)");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS log_upload (
                  id TEXT PRIMARY KEY,
                  file_name TEXT NOT NULL,
                  size INTEGER NOT NULL,
                  chunk_size INTEGER NOT NULL,
                  received TEXT NOT NULL,
                  input_id TEXT
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS log_comment (
                  id TEXT PRIMARY KEY,
                  source_id TEXT NOT NULL,
                  line_id TEXT NOT NULL,
                  path TEXT NOT NULL,
                  text TEXT NOT NULL,
                  author_profile_id TEXT,
                  created_at TEXT NOT NULL
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_log_comment_line ON log_comment(source_id, line_id)");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS log_saved_view (
                  id TEXT PRIMARY KEY,
                  source_id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  state_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                )
                """);
        // Sources created before lines carried their structure get the column and table now; their
        // lines are given a structure in the background (ShapeBackfillService).
        for (String id : jdbcTemplate.queryForList("SELECT id FROM log_source", String.class)) {
            if (SOURCE_ID.matcher(id).matches()) {
                ensureShapeSchema(id);
            }
        }
    }

    /**
     * Copies logs.db (and its write-ahead log, which SQLite replays on open) from the old location the
     * first time the new one is used. The old file is left where it was - delete it once satisfied.
     */
    private void migrateLegacy(Path target) {
        if (legacyFile == null || legacyFile.isBlank() || Files.exists(target)) {
            return;
        }
        Path legacy = Path.of(legacyFile);
        if (!Files.exists(legacy) || legacy.toAbsolutePath().equals(target.toAbsolutePath())) {
            return;
        }
        try {
            for (String suffix : new String[]{"-wal", ""}) {
                Path from = Path.of(legacyFile + suffix);
                if (Files.exists(from)) {
                    Files.copy(from, Path.of(target + suffix), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
            }
            org.slf4j.LoggerFactory.getLogger(SqliteLogsRepository.class)
                    .info("Copied {} to {} (the old file is kept; delete it when no longer needed)", legacy, target);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not copy " + legacy + " to " + target, e);
        }
    }

    @PreDestroy
    void close() {
        if (dataSource != null) {
            dataSource.close();
        }
    }

    /** Size of logs.db plus its write-ahead log, for the Settings Database table. */
    long storageSizeBytes() {
        long total = 0;
        for (String suffix : new String[]{"", "-wal"}) {
            Path p = Path.of(dbFile + suffix);
            try {
                total += Files.exists(p) ? Files.size(p) : 0;
            } catch (IOException e) {
                // Size is informational only; an unreadable WAL simply counts as 0.
            }
        }
        return total;
    }

    JdbcTemplate jdbc() {
        return jdbcTemplate;
    }

    DataSource dataSource() {
        return dataSource;
    }

    static String checked(String sourceId) {
        if (sourceId == null || !SOURCE_ID.matcher(sourceId).matches()) {
            throw new IllegalArgumentException("Not a log source id");
        }
        return sourceId;
    }

    static String lines(String sourceId) {
        return "ll_" + checked(sourceId);
    }

    static String fts(String sourceId) {
        return "fts_" + checked(sourceId);
    }

    static String groups(String sourceId) {
        return "lg_" + checked(sourceId);
    }

    static String patterns(String sourceId) {
        return "lp_" + checked(sourceId);
    }

    static String shapes(String sourceId) {
        return "ls_" + checked(sourceId);
    }

    void ensureShapeSchema(String sourceId) {
        String ll = lines(sourceId);
        java.util.List<String> cols = jdbcTemplate.queryForList("SELECT name FROM pragma_table_info('" + ll + "')", String.class);
        if (cols.isEmpty()) {
            return;
        }
        if (!cols.contains("shape")) {
            jdbcTemplate.execute("ALTER TABLE " + ll + " ADD COLUMN shape INTEGER");
        }
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_shape ON " + ll + "(shape)");
        // Level filters and sorts read the line's level (the level role, across its fields).
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_level ON " + ll + "(level, ts_ms)");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS " + shapes(sourceId) + " (id INTEGER PRIMARY KEY, name TEXT, template TEXT, "
                + "fields TEXT NOT NULL DEFAULT '', line_count INTEGER NOT NULL DEFAULT 0, field_counts TEXT NOT NULL DEFAULT '')");
    }

    void createSourceTables(String sourceId) {
        String ll = lines(sourceId);
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS " + ll + " ("
                + "rid INTEGER PRIMARY KEY, line_id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, "
                + "ts_ms INTEGER NOT NULL, ingested_ms INTEGER NOT NULL, level TEXT, group_level INTEGER NOT NULL DEFAULT 0, "
                + "group_path TEXT NOT NULL DEFAULT '', missing_level TEXT, pattern_id INTEGER, duration REAL, "
                + "pinned INTEGER NOT NULL DEFAULT 0, unparsed INTEGER NOT NULL DEFAULT 0, mismatch INTEGER NOT NULL DEFAULT 0, "
                + "bytes INTEGER NOT NULL DEFAULT 0, raw TEXT, shape INTEGER)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_ts ON " + ll + "(ts_ms, rid)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_input ON " + ll + "(input_id, byte_offset)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_group ON " + ll + "(group_path, group_level, ts_ms)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_pattern ON " + ll + "(pattern_id)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_ingested ON " + ll + "(ingested_ms)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + ll + "_level ON " + ll + "(level, ts_ms)");
        // Contentless (the text is already in ll_), trigram for fragment search, deletable for retention.
        jdbcTemplate.execute("CREATE VIRTUAL TABLE IF NOT EXISTS " + fts(sourceId)
                + " USING fts5(txt, content='', contentless_delete=1, tokenize='trigram')");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS " + groups(sourceId) + " ("
                + "path TEXT PRIMARY KEY, parent_path TEXT NOT NULL, level INTEGER NOT NULL, id TEXT NOT NULL, "
                + "first_ts INTEGER, last_ts INTEGER, line_count INTEGER NOT NULL DEFAULT 0, "
                + "error_count INTEGER NOT NULL DEFAULT 0, max_duration REAL)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS ix_" + groups(sourceId) + "_parent ON " + groups(sourceId) + "(parent_path)");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS " + patterns(sourceId) + " (id INTEGER PRIMARY KEY, template TEXT NOT NULL)");
        ensureShapeSchema(sourceId);
    }

    void dropSourceTables(String sourceId) {
        jdbcTemplate.execute("DROP TABLE IF EXISTS " + lines(sourceId));
        jdbcTemplate.execute("DROP TABLE IF EXISTS " + fts(sourceId));
        jdbcTemplate.execute("DROP TABLE IF EXISTS " + groups(sourceId));
        jdbcTemplate.execute("DROP TABLE IF EXISTS " + patterns(sourceId));
        jdbcTemplate.execute("DROP TABLE IF EXISTS " + shapes(sourceId));
    }
}
