package com.fathy.alfred.backend.settings.adapter.out.filestore;

import com.fathy.alfred.backend.settings.application.port.out.FilterSettingsStorePort;
import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
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

/**
 * A single global CallFilterSettings object persisted as a flat JSON file - same rationale as
 * JsonFileCommentsStoreAdapter (no database anywhere else in this app), cached in memory and
 * validated against the file's size/last-modified-time on every read, since isAllowed() (via
 * IsCallAllowedUseCase) is checked on every single incoming webhook call - re-parsing the file
 * from disk that often would be wasteful. {@code matchIfMissing = true} keeps file storage the
 * default so existing deployments (no {@code alfred.storage.filter-settings.type} set) work
 * unchanged.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.filter-settings", name = "type", havingValue = "file", matchIfMissing = true)
public class JsonFileFilterSettingsStoreAdapter implements FilterSettingsStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileFilterSettingsStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${FILTER_SETTINGS_FILE:/appdata/filter-settings.json}")
    private String filterSettingsFile;

    /** Null until the first read/write populates it. Immutable - replaced wholesale, never mutated in place. */
    private CallFilterSettings cachedSettings;
    private long cachedFileSize = -1;
    private long cachedModifiedMillis = -1;

    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(filterSettingsFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Filter-settings directory {} is not writable - saving settings will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create filter-settings directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public synchronized CallFilterSettings load() {
        return readSettings();
    }

    @Override
    public synchronized CallFilterSettings save(CallFilterSettings settings) {
        writeSettings(settings);
        return settings;
    }

    private CallFilterSettings readSettings() {
        Path path = Path.of(filterSettingsFile);
        if (!Files.exists(path)) {
            invalidateCache();
            return CallFilterSettings.defaults();
        }

        BasicFileAttributes attributes = readAttributes(path);
        if (cachedSettings != null && attributes != null
                && attributes.size() == cachedFileSize
                && attributes.lastModifiedTime().toMillis() == cachedModifiedMillis) {
            return cachedSettings;
        }

        try {
            CallFilterSettings parsed = objectMapper.readValue(Files.readString(path), CallFilterSettings.class);
            rememberCache(path, parsed);
            return parsed;
        } catch (IOException e) {
            invalidateCache();
            log.warn("Could not read filter-settings file {}, treating as defaults: {}", path, e.getMessage());
            return CallFilterSettings.defaults();
        }
    }

    private void writeSettings(CallFilterSettings settings) {
        try {
            Path path = Path.of(filterSettingsFile);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(settings));
            rememberCache(path, settings);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to write filter-settings file {}: {}", filterSettingsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    private void rememberCache(Path path, CallFilterSettings settings) {
        BasicFileAttributes attributes = readAttributes(path);
        if (attributes == null) {
            invalidateCache();
            return;
        }
        cachedSettings = settings;
        cachedFileSize = attributes.size();
        cachedModifiedMillis = attributes.lastModifiedTime().toMillis();
    }

    private void invalidateCache() {
        cachedSettings = null;
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
