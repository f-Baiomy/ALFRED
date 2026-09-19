package com.fathy.alfred.backend.redactions.adapter.out.redactionstore;

import com.fathy.alfred.backend.redactions.application.port.out.RedactionsStorePort;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
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
 * Flat-JSON persistence for redaction marks, mirroring JsonFileCommentsStoreAdapter exactly -
 * including its mtime/size-stamped in-memory cache, since GET /redactions?callId= filters over
 * findAll() and every visible call would otherwise re-parse the whole file. Swapping to another
 * store later means a new RedactionsStorePort implementation with its own {@code havingValue},
 * not touching RedactionsService or anything upstream of the port.
 *
 * <p>SqliteRedactionsStoreAdapter is the default; set {@code alfred.storage.redactions.type=file}
 * to opt into this one.
 *
 * <p>Note what this file does NOT contain: any secret value. A redaction stores only the name of
 * the header/body path/query param to mask, so this file is safe to back up and read. See
 * {@link Redaction}.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.redactions", name = "type", havingValue = "file")
public class JsonFileRedactionsStoreAdapter implements RedactionsStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileRedactionsStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${REDACTIONS_FILE:/appdata/redactions.json}")
    private String redactionsFile;

    /** Null until the first read/write populates it. Immutable - replaced wholesale, never mutated in place. */
    private List<Redaction> cachedRedactions;
    private long cachedFileSize = -1;
    private long cachedModifiedMillis = -1;

    /** Fail fast with a clear message if the redactions directory isn't writable, rather than only discovering it on the first POST. */
    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(redactionsFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Redactions directory {} is not writable - redaction creation will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create redactions directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public synchronized List<Redaction> findAll() {
        return readAll();
    }

    @Override
    public synchronized Redaction save(Redaction redaction) {
        List<Redaction> all = readAll();
        all.add(redaction);
        writeAll(all);
        return redaction;
    }

    @Override
    public synchronized boolean deleteById(String id) {
        List<Redaction> all = readAll();
        boolean removed = all.removeIf(r -> r.id().equals(id));
        if (removed) {
            writeAll(all);
        }
        return removed;
    }

    @Override
    public synchronized void replaceAll(List<Redaction> redactions) {
        writeAll(new ArrayList<>(redactions));
    }

    @Override
    public synchronized long storageSizeBytes() {
        try {
            return Files.size(Path.of(redactionsFile));
        } catch (IOException e) {
            return 0L;
        }
    }

    /** Returns a fresh mutable copy - save/deleteById mutate what they get back, and the cached snapshot itself must stay immutable. */
    private List<Redaction> readAll() {
        Path path = Path.of(redactionsFile);
        if (!Files.exists(path)) {
            invalidateCache();
            return new ArrayList<>();
        }

        BasicFileAttributes attributes = readAttributes(path);
        if (cachedRedactions != null && attributes != null
                && attributes.size() == cachedFileSize
                && attributes.lastModifiedTime().toMillis() == cachedModifiedMillis) {
            return new ArrayList<>(cachedRedactions);
        }

        try {
            Redaction[] parsed = objectMapper.readValue(Files.readString(path), Redaction[].class);
            List<Redaction> redactions = List.of(parsed);
            rememberCache(path, redactions);
            return new ArrayList<>(redactions);
        } catch (IOException e) {
            invalidateCache();
            log.warn("Could not read redactions file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(List<Redaction> redactions) {
        try {
            Path path = Path.of(redactionsFile);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(redactions));
            rememberCache(path, redactions);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to write redactions file {}: {}", redactionsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /** Caches an immutable snapshot stamped with the file's current size/mtime - or invalidates instead if the file can't be stat'd, so the next read re-parses rather than trusting an unverifiable snapshot. */
    private void rememberCache(Path path, List<Redaction> redactions) {
        BasicFileAttributes attributes = readAttributes(path);
        if (attributes == null) {
            invalidateCache();
            return;
        }
        cachedRedactions = List.copyOf(redactions);
        cachedFileSize = attributes.size();
        cachedModifiedMillis = attributes.lastModifiedTime().toMillis();
    }

    private void invalidateCache() {
        cachedRedactions = null;
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
