package com.fathy.alfred.backend.profiles.adapter.out.sqlite;

import com.fathy.alfred.backend.profiles.domain.model.Profile;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteProfilesRepositoryTest {

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
        Field field = SqliteProfilesRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private static Profile profile(String id) {
        return new Profile(id, "Ada", "2026-01-01T00:00:00Z", "🦊");
    }

    @Test
    void saveThenFindByIdRoundTrips() throws Exception {
        SqliteProfilesRepository repo = repositoryFor(tempDir.resolve("profiles.db"));

        repo.save(profile("p1"));

        Optional<Profile> found = repo.findById("p1");
        assertThat(found).contains(profile("p1"));
    }

    @Test
    void findByIdReturnsEmptyForAnUnknownId() throws Exception {
        SqliteProfilesRepository repo = repositoryFor(tempDir.resolve("profiles.db"));

        assertThat(repo.findById("missing")).isEmpty();
    }

    @Test
    void saveUpsertsAnExistingProfile() throws Exception {
        SqliteProfilesRepository repo = repositoryFor(tempDir.resolve("profiles.db"));
        repo.save(profile("p1"));

        repo.save(new Profile("p1", "New name", "2026-01-01T00:00:00Z", "🦊"));

        assertThat(repo.findAll()).hasSize(1);
        assertThat(repo.findById("p1")).get().extracting(Profile::name).isEqualTo("New name");
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingProfile() throws Exception {
        SqliteProfilesRepository repo = repositoryFor(tempDir.resolve("profiles.db"));
        repo.save(profile("p1"));
        repo.save(profile("p2"));

        assertThat(repo.deleteById("p1")).isTrue();

        assertThat(repo.findAll()).extracting(Profile::id).containsExactly("p2");
        assertThat(repo.deleteById("missing")).isFalse();
    }

    @Test
    void findAllReturnsEveryProfileInInsertionOrder() throws Exception {
        SqliteProfilesRepository repo = repositoryFor(tempDir.resolve("profiles.db"));
        repo.save(profile("p1"));
        repo.save(profile("p2"));

        assertThat(repo.findAll()).extracting(Profile::id).containsExactly("p1", "p2");
    }
}
