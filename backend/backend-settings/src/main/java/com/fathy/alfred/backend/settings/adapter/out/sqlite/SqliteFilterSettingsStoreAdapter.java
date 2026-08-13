package com.fathy.alfred.backend.settings.adapter.out.sqlite;

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
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Thin FilterSettingsStorePort implementation - all SQL/JDBC detail lives in
 * {@link SqliteFilterSettingsRepository}. The new default; set
 * {@code alfred.storage.filter-settings.type=file} to opt back into
 * {@code JsonFileFilterSettingsStoreAdapter}. Also runs the one-time migration from
 * filter-settings.json.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.filter-settings", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteFilterSettingsStoreAdapter implements FilterSettingsStorePort {

    private static final Logger log = LoggerFactory.getLogger(SqliteFilterSettingsStoreAdapter.class);

    private final SqliteFilterSettingsRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${FILTER_SETTINGS_FILE:/appdata/filter-settings.json}")
    private String legacyFile;

    public SqliteFilterSettingsStoreAdapter(SqliteFilterSettingsRepository repository) {
        this.repository = repository;
    }

    /** One-time, safely-rerunnable migration of filter-settings.json into settings.db - skipped once anything has already been saved or the legacy file doesn't exist. */
    @PostConstruct
    void migrateLegacyFileIfPresent() {
        Path path = Path.of(legacyFile);
        if (!Files.exists(path) || repository.hasAnyData()) {
            return;
        }
        try {
            CallFilterSettings settings = objectMapper.readValue(Files.readString(path), CallFilterSettings.class);
            repository.save(settings);
            Files.move(path, path.resolveSibling(path.getFileName() + ".migrated"));
            log.info("Migrated call-filter settings from {} into settings.db", path);
        } catch (IOException e) {
            log.error("Failed to migrate legacy filter-settings file {}: {}", path, e.getMessage());
        }
    }

    @Override
    public CallFilterSettings load() {
        return repository.load();
    }

    @Override
    public CallFilterSettings save(CallFilterSettings settings) {
        return repository.save(settings);
    }

    @Override
    public long storageSizeBytes() {
        return repository.storageSizeBytes();
    }
}
