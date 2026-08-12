package com.fathy.alfred.backend.profiles.adapter.out.sqlite;

import com.fathy.alfred.backend.profiles.domain.model.Profile;
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
import java.util.Optional;

/**
 * Owns every raw SQL/JDBC detail for profiles.db. {@link SqliteProfileStoreAdapter} is a thin
 * wrapper that implements ProfileStorePort purely by delegating here - same Repository pattern as
 * backend-calls' SqliteCallsRepository, scaled down since profiles are a small, unpaginated CRUD
 * collection (no search/sort/retention needed).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.profiles", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteProfilesRepository {

    @Value("${PROFILES_DB_FILE:/appdata/profiles.db}")
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
        config.setMaximumPoolSize(4);
        config.setPoolName("profiles-sqlite-pool");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("PRAGMA journal_mode=WAL");
        jdbcTemplate.execute("PRAGMA synchronous=NORMAL");
        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS profiles (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  created_at TEXT,
                  avatar TEXT
                )
                """);
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

    public List<Profile> findAll() {
        return jdbcTemplate.query("SELECT * FROM profiles ORDER BY rowid ASC", ROW_MAPPER);
    }

    public Optional<Profile> findById(String id) {
        return jdbcTemplate.query("SELECT * FROM profiles WHERE id = ?", ROW_MAPPER, id).stream().findFirst();
    }

    public Profile save(Profile profile) {
        jdbcTemplate.update("""
                INSERT INTO profiles (id, name, created_at, avatar) VALUES (?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at, avatar = excluded.avatar
                """,
                profile.id(), profile.name(), profile.createdAt(), profile.avatar());
        return profile;
    }

    public boolean deleteById(String id) {
        return jdbcTemplate.update("DELETE FROM profiles WHERE id = ?", id) > 0;
    }

    public int count() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM profiles", Integer.class);
        return result == null ? 0 : result;
    }

    private static final RowMapper<Profile> ROW_MAPPER = (rs, rowNum) -> new Profile(
            rs.getString("id"), rs.getString("name"), rs.getString("created_at"), rs.getString("avatar"));
}
