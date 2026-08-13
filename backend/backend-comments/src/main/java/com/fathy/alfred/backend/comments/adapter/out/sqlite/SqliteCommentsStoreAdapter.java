package com.fathy.alfred.backend.comments.adapter.out.sqlite;

import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Thin CommentsStorePort implementation - all SQL/JDBC detail lives in {@link SqliteCommentsRepository}.
 * The new default; set {@code alfred.storage.comments.type=file} to opt back into
 * {@code JsonFileCommentsStoreAdapter}. Also runs the one-time migration from comments.json.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.comments", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteCommentsStoreAdapter implements CommentsStorePort {

    private static final Logger log = LoggerFactory.getLogger(SqliteCommentsStoreAdapter.class);

    private final SqliteCommentsRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${COMMENTS_FILE:/appdata/comments.json}")
    private String legacyFile;

    public SqliteCommentsStoreAdapter(SqliteCommentsRepository repository) {
        this.repository = repository;
    }

    /** One-time, safely-rerunnable migration of comments.json into comments.db - skipped once the table already has rows or the legacy file doesn't exist. */
    @PostConstruct
    void migrateLegacyFileIfPresent() {
        Path path = Path.of(legacyFile);
        if (!Files.exists(path) || repository.count() > 0) {
            return;
        }
        try {
            Comment[] comments = objectMapper.readValue(Files.readString(path), Comment[].class);
            for (Comment comment : comments) {
                repository.save(comment);
            }
            Files.move(path, path.resolveSibling(path.getFileName() + ".migrated"));
            log.info("Migrated {} comment(s) from {} into comments.db", comments.length, path);
        } catch (IOException e) {
            log.error("Failed to migrate legacy comments file {}: {}", path, e.getMessage());
        }
    }

    @Override
    public List<Comment> findAll() {
        return repository.findAll();
    }

    @Override
    public Comment save(Comment comment) {
        return repository.save(comment);
    }

    @Override
    public boolean deleteById(String id) {
        return repository.deleteById(id);
    }

    @Override
    public void replaceAll(List<Comment> comments) {
        repository.replaceAll(comments);
    }

    @Override
    public long storageSizeBytes() {
        return repository.storageSizeBytes();
    }
}
