package com.fathy.alfred.backend.relive.adapter.out.sqlite;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Owns every raw SQL/JDBC detail for relive.db, including the pooled DataSource and every
 * table's schema. {@link SqliteReliveCycleStoreAdapter}, {@link SqliteReliveRunStoreAdapter} and
 * {@link SqliteLiveCallStoreAdapter} are thin wrappers around {@link #jdbc()} - same
 * one-repository-many-adapters split as {@code SqliteScenariosRepository}.
 *
 * <p>{@code definition_json}/{@code result_json}/{@code request_json}/{@code response_json} are
 * opaque TEXT columns, never parsed or queried into by this slice - this slice only measures
 * their serialized size and returns them verbatim (constitution I/II).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.relive", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteReliveRepository {

    @Value("${RELIVE_DB_FILE:/appdata/relive.db}")
    private String dbFile;

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

        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:sqlite:" + path);
        config.setMaximumPoolSize(10);
        config.setPoolName("relive-sqlite-pool");
        // journal_mode/synchronous/busy_timeout are per-connection in SQLite - connectionInitSql
        // applies them to every pooled connection Hikari opens (see SqliteScenariosRepository's
        // identical comment for why a one-off jdbcTemplate.execute() left most of the pool at
        // busy_timeout=0, causing SQLITE_BUSY under concurrent writes).
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS relive_cycles (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  description TEXT,
                  definition_json TEXT NOT NULL,
                  is_transient INTEGER NOT NULL DEFAULT 0,
                  step_count INTEGER NOT NULL DEFAULT 0,
                  child_count INTEGER NOT NULL DEFAULT 0,
                  live_count INTEGER NOT NULL DEFAULT 0,
                  cycle_rule_count INTEGER NOT NULL DEFAULT 0,
                  last_run_json TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """);
        // Existing databases predate the list's child/rule badges. Backfill once from the
        // stored definition; normal list requests still read summary columns only.
        var columns = jdbcTemplate.queryForList("PRAGMA table_info(relive_cycles)").stream()
                .map(row -> (String) row.get("name")).toList();
        if (!columns.contains("child_count")) {
            jdbcTemplate.execute("ALTER TABLE relive_cycles ADD COLUMN child_count INTEGER NOT NULL DEFAULT 0");
            jdbcTemplate.execute("""
                    UPDATE relive_cycles SET child_count = (
                      SELECT COUNT(*) FROM json_each(relive_cycles.definition_json, '$.steps')
                      WHERE json_extract(value, '$.parentKey') IS NOT NULL
                    )
                    """);
        }
        if (!columns.contains("cycle_rule_count")) {
            jdbcTemplate.execute("ALTER TABLE relive_cycles ADD COLUMN cycle_rule_count INTEGER NOT NULL DEFAULT 0");
            jdbcTemplate.execute("UPDATE relive_cycles SET cycle_rule_count = COALESCE(json_array_length(definition_json, '$.cycleRules'), 0)");
        }
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS relive_cycle_versions (
                  cycle_id TEXT NOT NULL,
                  version INTEGER NOT NULL,
                  saved_at TEXT NOT NULL,
                  reason TEXT,
                  definition_json TEXT NOT NULL,
                  PRIMARY KEY (cycle_id, version)
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_relive_cycle_versions_cycle_id ON relive_cycle_versions(cycle_id)");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS relive_runs (
                  id TEXT PRIMARY KEY,
                  cycle_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  driver TEXT NOT NULL,
                  started_at TEXT,
                  finished_at TEXT,
                  summary_json TEXT,
                  definition_json TEXT NOT NULL,
                  hold_json TEXT,
                  resumed_json TEXT,
                  variables_json TEXT,
                  log_json TEXT,
                  size_bytes INTEGER NOT NULL DEFAULT 0
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_relive_runs_cycle_id ON relive_runs(cycle_id)");
        // "Run from here" needs both after a reload; they used to be dropped on the first write.
        var runColumns = jdbcTemplate.queryForList("PRAGMA table_info(relive_runs)").stream()
                .map(row -> (String) row.get("name")).toList();
        if (!runColumns.contains("from_step_key")) {
            jdbcTemplate.execute("ALTER TABLE relive_runs ADD COLUMN from_step_key TEXT");
        }
        if (!runColumns.contains("seed_json")) {
            jdbcTemplate.execute("ALTER TABLE relive_runs ADD COLUMN seed_json TEXT");
        }
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS relive_step_results (
                  run_id TEXT NOT NULL,
                  step_key TEXT NOT NULL,
                  attempt INTEGER NOT NULL,
                  state TEXT NOT NULL,
                  result_json TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY (run_id, step_key, attempt)
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_relive_step_results_run_id ON relive_step_results(run_id)");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS relive_live_calls (
                  id TEXT PRIMARY KEY,
                  cycle_id TEXT NOT NULL,
                  run_id TEXT NOT NULL,
                  step_key TEXT,
                  reason TEXT NOT NULL,
                  method TEXT NOT NULL,
                  url TEXT NOT NULL,
                  status INTEGER NOT NULL,
                  duration_ms INTEGER NOT NULL,
                  at TEXT NOT NULL,
                  request_json TEXT NOT NULL,
                  response_json TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL DEFAULT 0
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_relive_live_calls_cycle_id ON relive_live_calls(cycle_id)");
        // The logged call a live call came from: Resend and Export on a Live calls row open it by
        // this id, and without the column both did nothing (T082).
        var liveCallColumns = jdbcTemplate.queryForList("PRAGMA table_info(relive_live_calls)").stream()
                .map(row -> (String) row.get("name")).toList();
        if (!liveCallColumns.contains("logged_call_id")) {
            jdbcTemplate.execute("ALTER TABLE relive_live_calls ADD COLUMN logged_call_id TEXT");
        }
    }

    @PreDestroy
    public void close() {
        if (dataSource != null) {
            try {
                jdbcTemplate.execute("PRAGMA wal_checkpoint(TRUNCATE)");
            } catch (Exception ignored) {
                // Best-effort - the pool is closing either way.
            }
            dataSource.close();
        }
    }

    JdbcTemplate jdbc() {
        return jdbcTemplate;
    }

    String dbFile() {
        return dbFile;
    }
}
