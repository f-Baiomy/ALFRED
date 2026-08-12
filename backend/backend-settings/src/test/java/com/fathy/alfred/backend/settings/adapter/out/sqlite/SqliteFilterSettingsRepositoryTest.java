package com.fathy.alfred.backend.settings.adapter.out.sqlite;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import com.fathy.alfred.backend.settings.domain.model.UrlRule;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteFilterSettingsRepositoryTest {

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
        Field field = SqliteFilterSettingsRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    @Test
    void loadReturnsDefaultsWhenNothingHasBeenSavedYet() throws Exception {
        SqliteFilterSettingsRepository repo = repositoryFor(tempDir.resolve("settings.db"));

        assertThat(repo.load()).isEqualTo(CallFilterSettings.defaults());
        assertThat(repo.hasAnyData()).isFalse();
    }

    @Test
    void saveThenLoadRoundTrips() throws Exception {
        SqliteFilterSettingsRepository repo = repositoryFor(tempDir.resolve("settings.db"));
        CallFilterSettings settings = new CallFilterSettings(
                FilterMode.ACCEPT_ONLY,
                List.of(new UrlRule("r1", "allowed.com", true)),
                List.of(new UrlRule("b1", "blocked.com", true)));

        repo.save(settings);

        assertThat(repo.load()).isEqualTo(settings);
        assertThat(repo.hasAnyData()).isTrue();
    }

    @Test
    void saveFullyOverwritesThePreviousWhitelistAndBlacklist() throws Exception {
        SqliteFilterSettingsRepository repo = repositoryFor(tempDir.resolve("settings.db"));
        repo.save(new CallFilterSettings(FilterMode.ACCEPT_ONLY, List.of(new UrlRule("r1", "old.com", true)), List.of()));

        CallFilterSettings replaced = new CallFilterSettings(FilterMode.ACCEPT_ALL, List.of(), List.of(new UrlRule("b1", "blocked.com", true)));
        repo.save(replaced);

        assertThat(repo.load()).isEqualTo(replaced);
    }

    @Test
    void persistsAcrossAFreshRepositoryInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("settings.db");
        CallFilterSettings settings = new CallFilterSettings(FilterMode.ACCEPT_ONLY, List.of(new UrlRule("r1", "a.com", false)), List.of());
        repositoryFor(file).save(settings);

        SqliteFilterSettingsRepository second = repositoryFor(file);

        assertThat(second.load()).isEqualTo(settings);
    }
}
