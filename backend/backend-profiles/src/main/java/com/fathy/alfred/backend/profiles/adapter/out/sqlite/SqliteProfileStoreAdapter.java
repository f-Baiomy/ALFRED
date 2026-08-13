package com.fathy.alfred.backend.profiles.adapter.out.sqlite;

import com.fathy.alfred.backend.profiles.application.port.out.ProfileStorePort;
import com.fathy.alfred.backend.profiles.domain.model.Profile;
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
import java.util.Optional;

/**
 * Thin ProfileStorePort implementation - all SQL/JDBC detail lives in {@link SqliteProfilesRepository}.
 * The new default; set {@code alfred.storage.profiles.type=file} to opt back into
 * {@code JsonFileProfileStoreAdapter}. Also runs the one-time migration from profiles.json.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.profiles", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteProfileStoreAdapter implements ProfileStorePort {

    private static final Logger log = LoggerFactory.getLogger(SqliteProfileStoreAdapter.class);

    private final SqliteProfilesRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${PROFILES_FILE:/appdata/profiles.json}")
    private String legacyFile;

    public SqliteProfileStoreAdapter(SqliteProfilesRepository repository) {
        this.repository = repository;
    }

    /** One-time, safely-rerunnable migration of profiles.json into profiles.db - skipped once the table already has rows or the legacy file doesn't exist. */
    @PostConstruct
    void migrateLegacyFileIfPresent() {
        Path path = Path.of(legacyFile);
        if (!Files.exists(path) || repository.count() > 0) {
            return;
        }
        try {
            Profile[] profiles = objectMapper.readValue(Files.readString(path), Profile[].class);
            for (Profile profile : profiles) {
                repository.save(profile);
            }
            Files.move(path, path.resolveSibling(path.getFileName() + ".migrated"));
            log.info("Migrated {} profile(s) from {} into profiles.db", profiles.length, path);
        } catch (IOException e) {
            log.error("Failed to migrate legacy profiles file {}: {}", path, e.getMessage());
        }
    }

    @Override
    public List<Profile> findAll() {
        return repository.findAll();
    }

    @Override
    public Optional<Profile> findById(String id) {
        return repository.findById(id);
    }

    @Override
    public Profile save(Profile profile) {
        return repository.save(profile);
    }

    @Override
    public boolean deleteById(String id) {
        return repository.deleteById(id);
    }

    @Override
    public long storageSizeBytes() {
        return repository.storageSizeBytes();
    }
}
