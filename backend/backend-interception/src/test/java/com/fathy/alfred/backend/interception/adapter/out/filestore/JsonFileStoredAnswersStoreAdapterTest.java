package com.fathy.alfred.backend.interception.adapter.out.filestore;

import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JsonFileStoredAnswersStoreAdapterTest {

    private static final String ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    @TempDir
    Path tempDir;

    private static StoredAnswer answer(String id) {
        return new StoredAnswer(id, StoredAnswer.Kind.FILE, 200, Map.of("content-type", "text/plain"), "text/plain",
                2, null, List.of(), null, null, null, null, "2026-09-23T12:00:00Z");
    }

    @Test
    void savesFindsAndDeletes() {
        JsonFileStoredAnswersStoreAdapter adapter = new JsonFileStoredAnswersStoreAdapter(tempDir.toString());

        adapter.save(answer(ID), "hi".getBytes());

        assertThat(adapter.findMeta(ID)).contains(answer(ID));
        assertThat(adapter.findBody(ID)).hasValueSatisfying(body -> assertThat(new String(body)).isEqualTo("hi"));
        adapter.delete(ID);
        assertThat(adapter.listMeta()).isEmpty();
        assertThat(Files.exists(tempDir.resolve(ID + ".body"))).isFalse();
    }

    @Test
    void anIdThatIsNotAUuidNeverBecomesAPath() {
        JsonFileStoredAnswersStoreAdapter adapter = new JsonFileStoredAnswersStoreAdapter(tempDir.resolve("store").toString());

        assertThatThrownBy(() -> adapter.save(answer("../escape"), "x".getBytes())).isInstanceOf(IllegalArgumentException.class);
        assertThat(adapter.findBody("../escape")).isEmpty();
        assertThat(Files.exists(tempDir.resolve("escape.body"))).isFalse();
    }
}
