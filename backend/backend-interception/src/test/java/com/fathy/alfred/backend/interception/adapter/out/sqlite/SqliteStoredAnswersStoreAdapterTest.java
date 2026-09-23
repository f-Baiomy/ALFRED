package com.fathy.alfred.backend.interception.adapter.out.sqlite;

import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteStoredAnswersStoreAdapterTest {

    private static final String ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    @TempDir
    Path tempDir;

    private SqliteInterceptionRulesRepository repository;
    private SqliteStoredAnswersStoreAdapter adapter;

    @BeforeEach
    void setUp() {
        repository = new SqliteInterceptionRulesRepository();
        ReflectionTestUtils.setField(repository, "dbFile", tempDir.resolve("interception.db").toString());
        repository.init();
        adapter = new SqliteStoredAnswersStoreAdapter(repository);
    }

    @AfterEach
    void tearDown() {
        repository.close();
    }

    private static StoredAnswer answer(Boolean secretsKept) {
        return new StoredAnswer(ID, StoredAnswer.Kind.RECORDED, 503, Map.of("content-type", "application/json"),
                "application/json", 3, secretsKept, List.of("set-cookie"), "inbound", "call-1", "cycle-1",
                "Tue, 22 Sep 2026 10:00:00 GMT", "2026-09-23T12:00:00Z");
    }

    @Test
    void metadataAndBodyRoundTripSeparately() {
        adapter.save(answer(false), new byte[] {1, 2, 3});

        assertThat(adapter.findMeta(ID)).contains(answer(false));
        assertThat(adapter.findBody(ID)).hasValueSatisfying(body -> assertThat(body).containsExactly(1, 2, 3));
        assertThat(adapter.listMeta()).containsExactly(answer(false));
    }

    @Test
    void aNullSecretsDecisionStaysNull() {
        adapter.save(answer(null), new byte[0]);

        assertThat(adapter.findMeta(ID).orElseThrow().secretsKept()).isNull();
    }

    @Test
    void deletingRemovesTheBodyToo() {
        adapter.save(answer(true), new byte[] {9});

        adapter.delete(ID);

        assertThat(adapter.findMeta(ID)).isEmpty();
        assertThat(adapter.findBody(ID)).isEmpty();
    }
}
