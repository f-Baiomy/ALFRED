package com.fathy.alfred.backend.interception.adapter.out.filestore;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionRulesStorePort;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * The {@code type=file} opt-out, kept alongside the SQLite adapter exactly as every other slice
 * keeps its legacy store (see docs/architecture.md). Caches by size+mtime like the other file
 * adapters, which is safe because this adapter is the sole writer of its file and re-stats on
 * every read.
 *
 * <p>Not to be confused with the rules SNAPSHOT that FileRulesPublisherAdapter writes. This file
 * is the store of record for authoring - it holds disabled rules, descriptions and timestamps.
 * The snapshot holds only what the proxy needs to evaluate.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.interception", name = "type", havingValue = "file")
public class JsonFileInterceptionRulesStoreAdapter implements InterceptionRulesStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileInterceptionRulesStoreAdapter.class);

    private final ObjectMapper mapper = new ObjectMapper().setSerializationInclusion(JsonInclude.Include.NON_NULL);

    @Value("${INTERCEPTION_RULES_STORE_FILE:/appdata/interception-rules-store.json}")
    private String storeFile;

    private long cachedSize = -1;
    private long cachedMtime = -1;
    private Stored cache = new Stored(false, List.of());

    private record Stored(boolean enabled, List<InterceptionRule> rules) {
        Stored {
            rules = rules == null ? List.of() : List.copyOf(rules);
        }
    }

    @PostConstruct
    void checkWritable() {
        Path path = Path.of(storeFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            if (!Files.exists(path)) {
                write(new Stored(false, List.of()));
            }
        } catch (IOException e) {
            log.error("Interception rules store {} is not writable: {}", storeFile, e.getMessage());
        }
    }

    @Override
    public synchronized List<InterceptionRule> findAll() {
        return read().rules();
    }

    @Override
    public synchronized void saveAll(List<InterceptionRule> rules) {
        write(new Stored(read().enabled(), rules));
    }

    @Override
    public synchronized boolean isEnabled() {
        return read().enabled();
    }

    @Override
    public synchronized void setEnabled(boolean enabled) {
        write(new Stored(enabled, read().rules()));
    }

    private Stored read() {
        Path path = Path.of(storeFile);
        try {
            if (!Files.exists(path)) {
                return new Stored(false, List.of());
            }
            long size = Files.size(path);
            long mtime = Files.getLastModifiedTime(path).toMillis();
            if (size == cachedSize && mtime == cachedMtime) {
                return cache;
            }
            Stored parsed = mapper.readValue(Files.readString(path, StandardCharsets.UTF_8), Stored.class);
            cachedSize = size;
            cachedMtime = mtime;
            cache = parsed;
            return parsed;
        } catch (IOException e) {
            log.error("Could not read {}, treating interception as having no rules: {}", storeFile, e.getMessage());
            return new Stored(false, List.of());
        }
    }

    private void write(Stored stored) {
        Path path = Path.of(storeFile);
        try {
            Files.writeString(path, mapper.writeValueAsString(stored), StandardCharsets.UTF_8);
            cachedSize = Files.size(path);
            cachedMtime = Files.getLastModifiedTime(path).toMillis();
            cache = stored;
        } catch (IOException e) {
            log.error("Could not write {}: {}", storeFile, e.getMessage());
        }
    }
}
