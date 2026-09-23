package com.fathy.alfred.backend.interception.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Owns every raw SQL/JDBC detail for interception.db. {@link SqliteInterceptionRulesStoreAdapter}
 * is a thin wrapper implementing the port by delegating here - same split as
 * SqliteFilterSettingsRepository/SqliteFilterSettingsStoreAdapter.
 *
 * <p>{@code match} and {@code actions} are stored as JSON text columns rather than normalised into
 * child tables. That is a deliberate exception to how the other slices model their data, and the
 * reason is that a rule is consumed as a DOCUMENT, never queried into: nothing ever asks "which
 * rules set a header called X". Normalising would mean three tables, two joins and an ordering
 * column to reassemble something that is written and read whole, and the JSON in these columns is
 * byte-for-byte what the proxy is handed - so there is exactly one representation of an action in
 * the system rather than two that must be kept in step.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.interception", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteInterceptionRulesRepository {

    private static final Logger log = LoggerFactory.getLogger(SqliteInterceptionRulesRepository.class);
    private static final String ENABLED_KEY = "enabled";

    private final ObjectMapper mapper = new ObjectMapper();

    @Value("${INTERCEPTION_DB_FILE:/appdata/interception.db}")
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
        config.setPoolName("interception-sqlite-pool");
        // See SqliteCallsRepository's identical comment - connectionInitSql applies these to every
        // pooled connection, which is what busy_timeout needs to actually prevent SQLITE_BUSY.
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS interception_rules (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    enabled INTEGER NOT NULL,
                    priority INTEGER NOT NULL,
                    stop_processing INTEGER NOT NULL,
                    match_json TEXT NOT NULL,
                    actions_json TEXT NOT NULL,
                    created_at TEXT,
                    updated_at TEXT
                )""");
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS interception_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_interception_priority ON interception_rules(priority)");
        // Stored answers: metadata and body in separate tables, so a listing never reads a body.
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS stored_answers (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status INTEGER,
                    headers_json TEXT NOT NULL,
                    content_type TEXT,
                    size_bytes INTEGER NOT NULL,
                    secrets_kept INTEGER,
                    secret_names_json TEXT,
                    source_direction TEXT,
                    source_call_id TEXT,
                    source_cycle_id TEXT,
                    recorded_at TEXT,
                    created_at TEXT NOT NULL
                )""");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS stored_answer_bodies (
                    answer_id TEXT PRIMARY KEY REFERENCES stored_answers(id) ON DELETE CASCADE,
                    body BLOB NOT NULL
                )""");
    }

    /** For {@link SqliteStoredAnswersStoreAdapter}, which shares this database and its pool. */
    JdbcTemplate jdbc() {
        return jdbcTemplate;
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

    public List<InterceptionRule> findAll() {
        return jdbcTemplate.query("SELECT * FROM interception_rules ORDER BY priority ASC, rowid ASC",
                (rs, rowNum) -> new InterceptionRule(
                        rs.getString("id"),
                        rs.getString("name"),
                        rs.getString("description"),
                        rs.getInt("enabled") == 1,
                        rs.getInt("priority"),
                        rs.getInt("stop_processing") == 1,
                        readMatch(rs.getString("match_json")),
                        readActions(rs.getString("actions_json")),
                        rs.getString("created_at"),
                        rs.getString("updated_at")));
    }

    public void saveAll(List<InterceptionRule> rules) {
        // Replace wholesale rather than diffing: the list is small, the service always has the
        // complete intended state in hand, and a diff would need its own ordering bookkeeping to
        // keep `rowid` tie-breaking meaningful after a reorder.
        jdbcTemplate.execute("DELETE FROM interception_rules");
        for (InterceptionRule rule : rules) {
            jdbcTemplate.update("""
                            INSERT INTO interception_rules
                            (id, name, description, enabled, priority, stop_processing, match_json, actions_json, created_at, updated_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    rule.id(), rule.name(), rule.description(), rule.enabled() ? 1 : 0, rule.priority(),
                    rule.stopProcessing() ? 1 : 0, write(rule.match()), write(rule.actions()),
                    rule.createdAt(), rule.updatedAt());
        }
    }

    public boolean isEnabled() {
        List<String> values = jdbcTemplate.query("SELECT value FROM interception_settings WHERE key = ?",
                (rs, rowNum) -> rs.getString("value"), ENABLED_KEY);
        // Defaults to OFF. A feature that can change live traffic must never be on because nobody
        // has said otherwise yet.
        return !values.isEmpty() && Boolean.parseBoolean(values.get(0));
    }

    public void setEnabled(boolean enabled) {
        jdbcTemplate.update("INSERT INTO interception_settings (key, value) VALUES (?,?) "
                + "ON CONFLICT(key) DO UPDATE SET value = excluded.value", ENABLED_KEY, String.valueOf(enabled));
    }

    private String write(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialise interception rule", e);
        }
    }

    private RuleMatch readMatch(String json) {
        try {
            return mapper.readValue(json, RuleMatch.class);
        } catch (JsonProcessingException e) {
            log.warn("Unreadable match on a stored rule, treating it as match-nothing: {}", e.getMessage());
            return RuleMatch.empty();
        }
    }

    private List<RuleAction> readActions(String json) {
        try {
            return List.of(mapper.readValue(json, RuleAction[].class));
        } catch (JsonProcessingException e) {
            // An unreadable action list makes the rule a no-op rather than taking the whole list
            // down - the service filters actionless rules out of what it publishes.
            log.warn("Unreadable actions on a stored rule, treating it as having none: {}", e.getMessage());
            return List.of();
        }
    }
}
