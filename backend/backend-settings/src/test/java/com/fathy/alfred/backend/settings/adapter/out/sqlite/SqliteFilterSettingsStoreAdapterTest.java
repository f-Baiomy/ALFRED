package com.fathy.alfred.backend.settings.adapter.out.sqlite;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import com.fathy.alfred.backend.settings.domain.model.UrlRule;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteFilterSettingsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private final List<SqliteFilterSettingsRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteFilterSettingsRepository::close);
        Thread.sleep(50);
    }

    private SqliteFilterSettingsRepository repositoryFor(Path dbFile) throws Exception {
        SqliteFilterSettingsRepository repository = new SqliteFilterSettingsRepository();
        setField(repository, SqliteFilterSettingsRepository.class, "dbFile", dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private SqliteFilterSettingsStoreAdapter adapterFor(SqliteFilterSettingsRepository repository, Path legacyFile) throws Exception {
        SqliteFilterSettingsStoreAdapter adapter = new SqliteFilterSettingsStoreAdapter(repository);
        setField(adapter, SqliteFilterSettingsStoreAdapter.class, "legacyFile", legacyFile.toString());
        return adapter;
    }

    private static void setField(Object target, Class<?> type, String name, Object value) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @Test
    void migratesTheLegacyFileAndRenamesIt() throws Exception {
        Path legacyFile = tempDir.resolve("filter-settings.json");
        Files.writeString(legacyFile, """
                {"mode":"ACCEPT_ONLY","whitelist":[{"id":"r1","host":"allowed.com","enabled":true}],"blacklist":[]}
                """);
        SqliteFilterSettingsRepository repository = repositoryFor(tempDir.resolve("settings.db"));
        SqliteFilterSettingsStoreAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        CallFilterSettings loaded = repository.load();
        assertThat(loaded.mode()).isEqualTo(FilterMode.ACCEPT_ONLY);
        assertThat(loaded.whitelist()).containsExactly(new UrlRule("r1", "allowed.com", true));
        assertThat(legacyFile).doesNotExist();
        assertThat(tempDir.resolve("filter-settings.json.migrated")).exists();
    }

    @Test
    void doesNothingWhenTheLegacyFileDoesNotExist() throws Exception {
        SqliteFilterSettingsRepository repository = repositoryFor(tempDir.resolve("settings.db"));
        SqliteFilterSettingsStoreAdapter adapter = adapterFor(repository, tempDir.resolve("missing.json"));

        adapter.migrateLegacyFileIfPresent();

        assertThat(repository.load()).isEqualTo(CallFilterSettings.defaults());
    }

    @Test
    void doesNotReMigrateOnceSettingsAlreadyExist() throws Exception {
        Path legacyFile = tempDir.resolve("filter-settings.json");
        Files.writeString(legacyFile, """
                {"mode":"ACCEPT_ONLY","whitelist":[],"blacklist":[]}
                """);
        SqliteFilterSettingsRepository repository = repositoryFor(tempDir.resolve("settings.db"));
        repository.save(new CallFilterSettings(FilterMode.ACCEPT_ALL, List.of(), List.of(new UrlRule("b1", "existing.com", true))));
        SqliteFilterSettingsStoreAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        assertThat(legacyFile).exists();
        assertThat(repository.load().mode()).isEqualTo(FilterMode.ACCEPT_ALL);
    }
}
