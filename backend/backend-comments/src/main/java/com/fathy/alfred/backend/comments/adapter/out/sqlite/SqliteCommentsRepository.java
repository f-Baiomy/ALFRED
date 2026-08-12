package com.fathy.alfred.backend.comments.adapter.out.sqlite;

import com.fathy.alfred.backend.comments.domain.model.Comment;
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
 * Owns every raw SQL/JDBC detail for comments.db. {@link SqliteCommentsStoreAdapter} is a thin
 * wrapper that implements CommentsStorePort purely by delegating here - same Repository pattern
 * as backend-calls' SqliteCallsRepository, scaled down since comments are a small, unpaginated
 * CRUD collection (no search/sort/retention needed).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.comments", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteCommentsRepository {

    @Value("${COMMENTS_DB_FILE:/appdata/comments.db}")
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
        config.setPoolName("comments-sqlite-pool");
        // See SqliteCallsRepository's identical comment - connectionInitSql applies these to
        // every pooled connection, not just one, which is what busy_timeout requires to actually
        // prevent SQLITE_BUSY under concurrent writes.
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        this.dataSource = new HikariDataSource(config);
        this.jdbcTemplate = new JdbcTemplate(dataSource);

        jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS comments (
                  id TEXT PRIMARY KEY,
                  call_id TEXT NOT NULL,
                  block TEXT,
                  line_index INTEGER,
                  line_text TEXT,
                  comment TEXT,
                  created_at TEXT
                )
                """);
        jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_comments_call_id ON comments(call_id)");
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

    public List<Comment> findAll() {
        return jdbcTemplate.query("SELECT * FROM comments ORDER BY rowid ASC", ROW_MAPPER);
    }

    public Comment save(Comment comment) {
        jdbcTemplate.update("""
                INSERT INTO comments (id, call_id, block, line_index, line_text, comment, created_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                comment.id(), comment.callId(), comment.block(), comment.lineIndex(), comment.lineText(),
                comment.comment(), comment.createdAt());
        return comment;
    }

    public boolean deleteById(String id) {
        return jdbcTemplate.update("DELETE FROM comments WHERE id = ?", id) > 0;
    }

    /** Not wrapped in a Spring @Transactional boundary - this DataSource is manually managed, not a Spring-registered bean, so there's no PlatformTransactionManager for it to hook into. Acceptable here since replaceAll is only ever called by the rare, one-time CommentCallIdMigration startup step in backend-app, not a regular request path. */
    public void replaceAll(List<Comment> comments) {
        jdbcTemplate.update("DELETE FROM comments");
        for (Comment comment : comments) {
            save(comment);
        }
    }

    public int count() {
        Integer result = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM comments", Integer.class);
        return result == null ? 0 : result;
    }

    private static final RowMapper<Comment> ROW_MAPPER = (rs, rowNum) -> new Comment(
            rs.getString("id"), rs.getString("call_id"), rs.getString("block"), rs.getInt("line_index"),
            rs.getString("line_text"), rs.getString("comment"), rs.getString("created_at"));
}
