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

class SqliteRedactionsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private final List<SqliteRedactionsRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteRedactionsRepository::close);
        Thread.sleep(50);
    }

    private SqliteRedactionsStoreAdapter adapterFor(Path dbFile) throws Exception {
        SqliteRedactionsRepository repository = new SqliteRedactionsRepository();
        Field field = SqliteRedactionsRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, dbFile.toString());
        repository.init();
        opened.add(repository);
        return new SqliteRedactionsStoreAdapter(repository);
    }

    private static Redaction redaction(String id) {
        return new Redaction(id, RedactionScope.CALL, "call-1", RedactionKind.REQUEST_HEADER, "authorization", "2026-01-01T00:00:00Z");
    }

    @Test
    void savesAndListsThroughThePort() throws Exception {
        SqliteRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.db"));

        adapter.save(redaction("r1"));
        adapter.save(redaction("r2"));

        assertThat(adapter.findAll()).extracting(Redaction::id).containsExactlyInAnyOrder("r1", "r2");
    }

    @Test
    void deletesThroughThePort() throws Exception {
        SqliteRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.db"));
        adapter.save(redaction("r1"));

        assertThat(adapter.deleteById("r1")).isTrue();
        assertThat(adapter.deleteById("r1")).isFalse();
        assertThat(adapter.findAll()).isEmpty();
    }

    @Test
    void replacesAllThroughThePort() throws Exception {
        SqliteRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.db"));
        adapter.save(redaction("r1"));

        Redaction only = new Redaction("r2", RedactionScope.ALL, null, RedactionKind.URL_PARAM, "api_key", "t");
        adapter.replaceAll(List.of(only));

        assertThat(adapter.findAll()).containsExactly(only);
    }

    @Test
    void reportsStorageSize() throws Exception {
        SqliteRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.db"));
        adapter.save(redaction("r1"));

        assertThat(adapter.storageSizeBytes()).isPositive();
    }
}
