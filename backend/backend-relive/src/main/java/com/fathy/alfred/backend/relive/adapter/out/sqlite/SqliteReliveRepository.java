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
                  live_count INTEGER NOT NULL DEFAULT 0,
                  last_run_json TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """);
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
