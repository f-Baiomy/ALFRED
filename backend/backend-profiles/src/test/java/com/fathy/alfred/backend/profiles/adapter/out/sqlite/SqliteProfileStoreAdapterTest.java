package com.fathy.alfred.backend.profiles.adapter.out.sqlite;

import com.fathy.alfred.backend.profiles.domain.model.Profile;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteProfileStoreAdapterTest {

    @TempDir
    Path tempDir;

    private final List<SqliteProfilesRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteProfilesRepository::close);
        Thread.sleep(50);
    }

    private SqliteProfilesRepository repositoryFor(Path dbFile) throws Exception {
        SqliteProfilesRepository repository = new SqliteProfilesRepository();
        setField(repository, SqliteProfilesRepository.class, "dbFile", dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private SqliteProfileStoreAdapter adapterFor(SqliteProfilesRepository repository, Path legacyFile) throws Exception {
        SqliteProfileStoreAdapter adapter = new SqliteProfileStoreAdapter(repository);
        setField(adapter, SqliteProfileStoreAdapter.class, "legacyFile", legacyFile.toString());
        return adapter;
    }

    private static void setField(Object target, Class<?> type, String name, Object value) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @Test
    void migratesEveryProfileFromTheLegacyFileAndRenamesIt() throws Exception {
        Path legacyFile = tempDir.resolve("profiles.json");
        Files.writeString(legacyFile, """
                [{"id":"p1","name":"Ada","createdAt":"2026-01-01T00:00:00Z","avatar":"🦊"}]
                """);
        SqliteProfilesRepository repository = repositoryFor(tempDir.resolve("profiles.db"));
        SqliteProfileStoreAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        assertThat(repository.findAll()).containsExactly(new Profile("p1", "Ada", "2026-01-01T00:00:00Z", "🦊"));
        assertThat(legacyFile).doesNotExist();
        assertThat(tempDir.resolve("profiles.json.migrated")).exists();
    }

    @Test
    void doesNothingWhenTheLegacyFileDoesNotExist() throws Exception {
        SqliteProfilesRepository repository = repositoryFor(tempDir.resolve("profiles.db"));
        SqliteProfileStoreAdapter adapter = adapterFor(repository, tempDir.resolve("missing.json"));

        adapter.migrateLegacyFileIfPresent();

        assertThat(repository.findAll()).isEmpty();
    }

    @Test
    void doesNotReMigrateOnceProfilesAlreadyExist() throws Exception {
        Path legacyFile = tempDir.resolve("profiles.json");
        Files.writeString(legacyFile, """
                [{"id":"p1","name":"Ada","createdAt":"2026-01-01T00:00:00Z","avatar":"🦊"}]
                """);
        SqliteProfilesRepository repository = repositoryFor(tempDir.resolve("profiles.db"));
        repository.save(new Profile("existing", "Existing", "t", "🐝"));
        SqliteProfileStoreAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        assertThat(legacyFile).exists();
        assertThat(repository.findAll()).extracting(Profile::id).containsExactly("existing");
    }
}
