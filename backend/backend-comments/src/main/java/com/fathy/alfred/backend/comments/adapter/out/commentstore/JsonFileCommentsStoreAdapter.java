package com.fathy.alfred.backend.comments.adapter.out.commentstore;

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
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
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
 *
 * <p>Parsed contents are cached in memory and validated against the file's size/last-modified-time
 * on every read (same approach and rationale as FileCallLogAdapter). {@code GET /comments?callId=}
 * filters over findAll(), so every visible call card's comment lookup used to re-parse the whole
 * file.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.comments", name = "type", havingValue = "file", matchIfMissing = true)
public class JsonFileCommentsStoreAdapter implements CommentsStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileCommentsStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${COMMENTS_FILE:/appdata/comments.json}")
    private String commentsFile;

    /** Null until the first read/write populates it. Immutable - replaced wholesale, never mutated in place. */
    private List<Comment> cachedComments;
    private long cachedFileSize = -1;
    private long cachedModifiedMillis = -1;

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

    /** Returns a fresh mutable copy - save/deleteById mutate what they get back, and the cached snapshot itself must stay immutable. */
    private List<Comment> readAll() {
        Path path = Path.of(commentsFile);
        if (!Files.exists(path)) {
            invalidateCache();
            return new ArrayList<>();
        }

        BasicFileAttributes attributes = readAttributes(path);
        if (cachedComments != null && attributes != null
                && attributes.size() == cachedFileSize
                && attributes.lastModifiedTime().toMillis() == cachedModifiedMillis) {
            return new ArrayList<>(cachedComments);
        }

        try {
            Comment[] parsed = objectMapper.readValue(Files.readString(path), Comment[].class);
            List<Comment> comments = List.of(parsed);
            rememberCache(path, comments);
            return new ArrayList<>(comments);
        } catch (IOException e) {
            invalidateCache();
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
            rememberCache(path, comments);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to write comments file {}: {}", commentsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Caches an immutable snapshot stamped with the file's current size/mtime - or invalidates instead if the file can't be stat'd, so the next read re-parses rather than trusting an unverifiable snapshot. */
    private void rememberCache(Path path, List<Comment> comments) {
        BasicFileAttributes attributes = readAttributes(path);
        if (attributes == null) {
            invalidateCache();
            return;
        }
        cachedComments = List.copyOf(comments);
        cachedFileSize = attributes.size();
        cachedModifiedMillis = attributes.lastModifiedTime().toMillis();
    }

    private void invalidateCache() {
        cachedComments = null;
        cachedFileSize = -1;
        cachedModifiedMillis = -1;
    }

    private BasicFileAttributes readAttributes(Path path) {
        try {
            return Files.readAttributes(path, BasicFileAttributes.class);
        } catch (IOException e) {
            return null;
        }
    }
}
