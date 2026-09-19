package com.fathy.alfred.backend.redactions.adapter.out.sqlite;

import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;
import com.fathy.alfred.backend.redactions.domain.model.RedactionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteRedactionsRepositoryTest {

    @TempDir
    Path tempDir;

    private final List<SqliteRedactionsRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteRedactionsRepository::close);
        Thread.sleep(50);
    }

    private SqliteRedactionsRepository repositoryFor(Path dbFile) throws Exception {
        SqliteRedactionsRepository repository = new SqliteRedactionsRepository();
        Field field = SqliteRedactionsRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private static Redaction redaction(String id) {
        return new Redaction(id, RedactionScope.CALL, "call-1", RedactionKind.REQUEST_HEADER, "authorization", "2026-01-01T00:00:00Z");
    }

    @Test
    void saveThenFindAllRoundTrips() throws Exception {
        SqliteRedactionsRepository repo = repositoryFor(tempDir.resolve("redactions.db"));

        repo.save(redaction("r1"));
        repo.save(redaction("r2"));

        assertThat(repo.findAll()).extracting(Redaction::id).containsExactlyInAnyOrder("r1", "r2");
    }

    @Test
    void roundTripsScopeKindAndANullCallId() throws Exception {
        SqliteRedactionsRepository repo = repositoryFor(tempDir.resolve("redactions.db"));
        Redaction global = new Redaction("r1", RedactionScope.ALL, null, RedactionKind.RESPONSE_BODY_KEY, "data.accessToken", "t");

        repo.save(global);

        assertThat(repo.findAll()).containsExactly(global);
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingRedaction() throws Exception {
        SqliteRedactionsRepository repo = repositoryFor(tempDir.resolve("redactions.db"));
        repo.save(redaction("r1"));
        repo.save(redaction("r2"));

        boolean removed = repo.deleteById("r1");

        assertThat(removed).isTrue();
        assertThat(repo.findAll()).extracting(Redaction::id).containsExactly("r2");
    }

    @Test
    void deleteByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        SqliteRedactionsRepository repo = repositoryFor(tempDir.resolve("redactions.db"));
        repo.save(redaction("r1"));

        assertThat(repo.deleteById("missing")).isFalse();
        assertThat(repo.findAll()).hasSize(1);
    }

    @Test
    void replaceAllOverwritesEveryRedaction() throws Exception {
        SqliteRedactionsRepository repo = repositoryFor(tempDir.resolve("redactions.db"));
        repo.save(redaction("r1"));
        repo.save(redaction("r2"));

        Redaction only = new Redaction("r3", RedactionScope.ALL, null, RedactionKind.URL_PARAM, "api_key", "t");
        repo.replaceAll(List.of(only));

        assertThat(repo.findAll()).containsExactly(only);
    }

    @Test
    void countsAndReportsStorageSize() throws Exception {
        SqliteRedactionsRepository repo = repositoryFor(tempDir.resolve("redactions.db"));
        repo.save(redaction("r1"));

        assertThat(repo.count()).isEqualTo(1);
        assertThat(repo.storageSizeBytes()).isPositive();
    }

    @Test
    void persistsAcrossAFreshRepositoryPointedAtTheSameFile() throws Exception {
        Path dbFile = tempDir.resolve("redactions.db");
        repositoryFor(dbFile).save(redaction("r1"));

        SqliteRedactionsRepository secondInstance = repositoryFor(dbFile);

        assertThat(secondInstance.findAll()).extracting(Redaction::id).containsExactly("r1");
    }
}
