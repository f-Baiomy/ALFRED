package com.fathy.alfred.backend.redactions.adapter.out.sqlite;

import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;
import com.fathy.alfred.backend.redactions.domain.model.RedactionScope;
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
 * Owns every raw SQL/JDBC detail for redactions.db. {@link SqliteRedactionsStoreAdapter} is a thin
 * wrapper that implements RedactionsStorePort purely by delegating here - same Repository pattern
 * as SqliteCommentsRepository, and like it a small, unpaginated CRUD collection (no
 * search/sort/retention needed).
 *
 * <p>The {@code name} column holds header names / body key paths / query-param names only - never
 * a secret's value. Nothing in this schema should ever grow a column that would.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.redactions", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteRedactionsRepository {

    @Value("${REDACTIONS_DB_FILE:/appdata/redactions.db}")
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
        config.setPoolName("redactions-sqlite-pool");
        // See SqliteCallsRepository's identical comment - connectionInitSql applies these to
        // every pooled connection, not just one, which is what busy_timeout requires to actually
        // prevent SQLITE_BUSY under concurrent writes.
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS redactions (
                  id TEXT PRIMARY KEY,
                  scope TEXT NOT NULL,
                  call_id TEXT,
                  kind TEXT NOT NULL,
                  name TEXT NOT NULL,
                  created_at TEXT
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_redactions_call_id ON redactions(call_id)");
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

    public List<Redaction> findAll() {
        return jdbcTemplate.query("SELECT * FROM redactions ORDER BY rowid ASC", ROW_MAPPER);
    }

    public Redaction save(Redaction redaction) {
        jdbcTemplate.update("""
                INSERT INTO redactions (id, scope, call_id, kind, name, created_at)
                VALUES (?,?,?,?,?,?)
                """,
                redaction.id(),
                redaction.scope() == null ? null : redaction.scope().name(),
                redaction.callId(),
                redaction.kind() == null ? null : redaction.kind().name(),
                redaction.name(),
                redaction.createdAt());
        return redaction;
    }

    public boolean deleteById(String id) {
        return jdbcTemplate.update("DELETE FROM redactions WHERE id = ?", id) > 0;
    }

    /** Not wrapped in a Spring @Transactional boundary - this DataSource is manually managed, not a Spring-registered bean, so there's no PlatformTransactionManager for it to hook into. Same trade-off as SqliteCommentsRepository.replaceAll, and likewise not on a request path. */
    public void replaceAll(List<Redaction> redactions) {
        jdbcTemplate.update("DELETE FROM redactions");
        for (Redaction redaction : redactions) {
            save(redaction);
        }
    }

    public int count() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM redactions", Integer.class);
        return result == null ? 0 : result;
    }

    /** Bytes currently on disk for redactions.db - drives the Database settings tab's file-size table. Returns 0 if the file doesn't exist yet rather than throwing. */
    public long storageSizeBytes() {
        try {
            return Files.size(Path.of(dbFile));
        } catch (IOException e) {
            return 0L;
        }
    }

    private static final RowMapper<Redaction> ROW_MAPPER = (rs, rowNum) -> new Redaction(
            rs.getString("id"),
            enumValue(RedactionScope.class, rs.getString("scope")),
            rs.getString("call_id"),
            enumValue(RedactionKind.class, rs.getString("kind")),
            rs.getString("name"),
            rs.getString("created_at"));

    /** Tolerates a row written by a newer version with an enum constant this one doesn't know - that row comes back with a null scope/kind instead of blowing up the whole listing. */
    private static <E extends Enum<E>> E enumValue(Class<E> type, String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return Enum.valueOf(type, raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
