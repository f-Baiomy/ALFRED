package com.fathy.alfred.backend.settings.adapter.out.sqlite;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import com.fathy.alfred.backend.settings.domain.model.UrlRule;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Owns every raw SQL/JDBC detail for settings.db. {@link SqliteFilterSettingsStoreAdapter} is a
 * thin wrapper that implements FilterSettingsStorePort purely by delegating here. {@code mode} is
 * a scalar setting (not an entity list), so it gets a plain key/value row rather than a UUID;
 * whitelist/blacklist entries are entities and keep their own UUID ids, same convention as every
 * other table in this migration.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.filter-settings", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteFilterSettingsRepository {

    @Value("${FILTER_SETTINGS_DB_FILE:/appdata/settings.db}")
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
        config.setPoolName("settings-sqlite-pool");
        // See SqliteCallsRepository's identical comment - connectionInitSql applies these to
        // every pooled connection, not just one, which is what busy_timeout requires to actually
        // prevent SQLITE_BUSY under concurrent writes.
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS filter_mode (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS whitelist_rules (id TEXT PRIMARY KEY, host TEXT NOT NULL, enabled INTEGER NOT NULL)");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS blacklist_rules (id TEXT PRIMARY KEY, host TEXT NOT NULL, enabled INTEGER NOT NULL)");
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

    public CallFilterSettings load() {
        FilterMode mode = jdbcTemplate.query("SELECT value FROM filter_mode WHERE key = 'mode'",
                        (rs, rowNum) -> FilterMode.valueOf(rs.getString("value")))
                .stream().findFirst().orElse(FilterMode.ACCEPT_ALL);
        List<UrlRule> whitelist = jdbcTemplate.query("SELECT * FROM whitelist_rules ORDER BY rowid ASC", RULE_ROW_MAPPER);
        List<UrlRule> blacklist = jdbcTemplate.query("SELECT * FROM blacklist_rules ORDER BY rowid ASC", RULE_ROW_MAPPER);
        return new CallFilterSettings(mode, whitelist, blacklist);
    }

    /** Full overwrite - matches FilterSettingsStorePort.save's "the whole object, every time" contract (the same shape JsonFileFilterSettingsStoreAdapter already implements by rewriting the whole file). */
    public CallFilterSettings save(CallFilterSettings settings) {
        jdbcTemplate.update("""
                INSERT INTO filter_mode (key, value) VALUES ('mode', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """, settings.mode().name());

        jdbcTemplate.update("DELETE FROM whitelist_rules");
        for (UrlRule rule : settings.whitelist()) {
            jdbcTemplate.update("INSERT INTO whitelist_rules (id, host, enabled) VALUES (?,?,?)",
                    rule.id(), rule.host(), rule.enabled() ? 1 : 0);
        }

        jdbcTemplate.update("DELETE FROM blacklist_rules");
        for (UrlRule rule : settings.blacklist()) {
            jdbcTemplate.update("INSERT INTO blacklist_rules (id, host, enabled) VALUES (?,?,?)",
                    rule.id(), rule.host(), rule.enabled() ? 1 : 0);
        }

        return settings;
    }

    /** Whether any settings have ever been saved - migration uses this to decide whether to import the legacy file. */
    public boolean hasAnyData() {
        Integer modeCount = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM filter_mode", Integer.class);
        Integer whitelistCount = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM whitelist_rules", Integer.class);
        Integer blacklistCount = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM blacklist_rules", Integer.class);
        return (modeCount != null && modeCount > 0) || (whitelistCount != null && whitelistCount > 0) || (blacklistCount != null && blacklistCount > 0);
    }

    /** Bytes currently on disk for settings.db - drives the Database settings tab's file-size table. Returns 0 if the file doesn't exist yet rather than throwing. */
    public long storageSizeBytes() {
        try {
            return Files.size(Path.of(dbFile));
        } catch (IOException e) {
            return 0L;
        }
    }

    private static final RowMapper<UrlRule> RULE_ROW_MAPPER = (rs, rowNum) -> new UrlRule(
            rs.getString("id"), rs.getString("host"), rs.getInt("enabled") != 0);
}
