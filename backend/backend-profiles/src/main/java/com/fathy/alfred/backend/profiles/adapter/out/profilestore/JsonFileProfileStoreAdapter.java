package com.fathy.alfred.backend.profiles.adapter.out.profilestore;

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
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Profiles are persisted as a flat JSON file, same rationale as JsonFileCommentsStoreAdapter -
 * this app has no database anywhere else, and profile volume is small (one team's worth of
 * people). Swapping to Redis/MySQL/etc. later means writing a new ProfileStorePort implementation
 * with its own {@code havingValue} (e.g. "redis"), not touching ProfilesService or anything
 * upstream of the port. SqliteProfileStoreAdapter is the default now (see the migration plan);
 * set {@code alfred.storage.profiles.type=file} to opt back into this adapter.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.profiles", name = "type", havingValue = "file")
public class JsonFileProfileStoreAdapter implements ProfileStorePort {

    private static final Logger log = LoggerFactory.getLogger(JsonFileProfileStoreAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${PROFILES_FILE:/appdata/profiles.json}")
    private String profilesFile;

    /** Fail fast with a clear message if the profiles directory isn't writable, rather than only discovering it on the first POST. */
    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(profilesFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Profiles directory {} is not writable - profile creation will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create profiles directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public synchronized List<Profile> findAll() {
        return readAll();
    }

    @Override
    public synchronized Optional<Profile> findById(String id) {
        return readAll().stream().filter(p -> p.id().equals(id)).findFirst();
    }

    @Override
    public synchronized Profile save(Profile profile) {
        List<Profile> all = readAll();
        all.removeIf(p -> p.id().equals(profile.id()));
        all.add(profile);
        writeAll(all);
        return profile;
    }

    @Override
    public synchronized boolean deleteById(String id) {
        List<Profile> all = readAll();
        boolean removed = all.removeIf(p -> p.id().equals(id));
        if (removed) {
            writeAll(all);
        }
        return removed;
    }

    private List<Profile> readAll() {
        Path path = Path.of(profilesFile);
        if (!Files.exists(path)) {
            return new ArrayList<>();
        }
        try {
            Profile[] parsed = objectMapper.readValue(Files.readString(path), Profile[].class);
            return new ArrayList<>(List.of(parsed));
        } catch (IOException e) {
            log.warn("Could not read profiles file {}, treating as empty: {}", path, e.getMessage());
            return new ArrayList<>();
        }
    }

    private void writeAll(List<Profile> profiles) {
        try {
            Path path = Path.of(profilesFile);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(profiles));
        } catch (IOException e) {
            log.error("Failed to write profiles file {}: {}", profilesFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
