package com.alfred.pennyworth.comments.adapter.out.commentstore;

import com.alfred.pennyworth.comments.application.port.out.CommentsStorePort;
import com.alfred.pennyworth.comments.domain.model.Comment;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Comments are flagged issues on a specific line of a call's request/response, for the
 * support-team export workflow. Persisted as a flat JSON file rather than a database - this app
 * has no database anywhere else either, and comment volume is small (one team, ad-hoc
 * annotations). Swapping to Redis/MySQL/etc. later means writing a new CommentsStorePort
 * implementation with its own {@code havingValue} (e.g. "redis"), not touching CommentsService or
 * anything upstream of the port. {@code matchIfMissing = true} keeps this the default so existing
 * deployments (no {@code alfred.storage.comments.type} set) behave exactly as before.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.comments", name = "type", havingValue = "file", matchIfMissing = true)
public class JsonFileCommentsStoreAdapter implements CommentsStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileCommentsStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${COMMENTS_FILE:/appdata/comments.json}")
    private String commentsFile;

    /** Fail fast with a clear message if the comments directory isn't writable, rather than only discovering it on the first POST. */
    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(commentsFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Comments directory {} is not writable - comment creation will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create comments directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public synchronized List<Comment> findAll() {
        return readAll();
    }

    @Override
    public synchronized Comment save(Comment comment) {
        List<Comment> all = readAll();
        all.add(comment);
        writeAll(all);
        return comment;
    }

    @Override
    public synchronized boolean deleteById(String id) {
        List<Comment> all = readAll();
        boolean removed = all.removeIf(c -> c.id().equals(id));
        if (removed) {
            writeAll(all);
        }
        return removed;
    }

    private List<Comment> readAll() {
        Path path = Path.of(commentsFile);
        if (!Files.exists(path)) {
            return new ArrayList<>();
        }
        try {
            Comment[] parsed = objectMapper.readValue(Files.readString(path), Comment[].class);
            return new ArrayList<>(List.of(parsed));
        } catch (IOException e) {
            log.warn("Could not read comments file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(List<Comment> comments) {
        try {
            Path path = Path.of(commentsFile);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(comments));
        } catch (IOException e) {
            log.error("Failed to write comments file {}: {}", commentsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
