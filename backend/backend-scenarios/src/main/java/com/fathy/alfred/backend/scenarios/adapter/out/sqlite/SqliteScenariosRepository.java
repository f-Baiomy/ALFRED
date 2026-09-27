package com.fathy.alfred.backend.scenarios.adapter.out.sqlite;

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
 * Owns every raw SQL/JDBC detail for scenarios.db, including the pooled DataSource and both
 * tables' schema. {@link SqliteScenarioStoreAdapter} and {@link SqliteScenarioRunStoreAdapter} are
 * thin wrappers around {@link #jdbc()} - same one-repository-two-adapters split as
 * backend-interception's SqliteInterceptionRulesRepository (rules) /
 * SqliteStoredAnswersStoreAdapter (answers), which also share one connection pool across two
 * related tables in the same physical database file.
 *
 * <p>{@code definition_json}/{@code results_json} are stored as opaque TEXT columns, never parsed
 * or queried into by this slice (see Scenario.definition's doc) - this slice only measures their
 * serialized size (ScenariosService) and returns them verbatim.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.scenarios", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteScenariosRepository {

    @Value("${SCENARIOS_DB_FILE:/appdata/scenarios.db}")
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
        config.setPoolName("scenarios-sqlite-pool");
        // journal_mode/synchronous/busy_timeout are per-connection in SQLite - connectionInitSql
        // applies them to every pooled connection Hikari opens, not just one (see
        // SqliteCallsRepository's identical comment for why a one-off jdbcTemplate.execute() left
        // most of the pool at busy_timeout=0, causing SQLITE_BUSY under concurrent writes).
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS scenarios (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  description TEXT,
                  definition_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS scenario_runs (
                  id TEXT PRIMARY KEY,
                  scenario_id TEXT NOT NULL,
                  started_at TEXT,
                  finished_at TEXT,
                  summary_total INTEGER NOT NULL,
                  summary_passed INTEGER NOT NULL,
                  summary_failed INTEGER NOT NULL,
                  summary_errored INTEGER NOT NULL,
                  results_json TEXT
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_scenario_runs_scenario_id ON scenario_runs(scenario_id)");
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
