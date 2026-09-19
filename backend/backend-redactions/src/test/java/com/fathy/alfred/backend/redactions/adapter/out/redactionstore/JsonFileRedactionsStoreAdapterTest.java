package com.fathy.alfred.backend.redactions.adapter.out.redactionstore;

import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;
import com.fathy.alfred.backend.redactions.domain.model.RedactionScope;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileRedactionsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private JsonFileRedactionsStoreAdapter adapterFor(Path redactionsFile) throws Exception {
        JsonFileRedactionsStoreAdapter adapter = new JsonFileRedactionsStoreAdapter();
        Field field = JsonFileRedactionsStoreAdapter.class.getDeclaredField("redactionsFile");
        field.setAccessible(true);
        field.set(adapter, redactionsFile.toString());
        return adapter;
    }

    private static Redaction redaction(String id) {
        return new Redaction(id, RedactionScope.CALL, "call-1", RedactionKind.REQUEST_HEADER, "authorization", "2026-01-01T00:00:00Z");
    }

    @Test
    void findAllReturnsEmptyWhenTheFileDoesNotExistYet() throws Exception {
        JsonFileRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.json"));

        assertThat(adapter.findAll()).isEmpty();
    }

    @Test
    void saveThenFindAllRoundTrips() throws Exception {
        JsonFileRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.json"));

        adapter.save(redaction("r1"));
        adapter.save(redaction("r2"));

        assertThat(adapter.findAll()).extracting(Redaction::id).containsExactlyInAnyOrder("r1", "r2");
    }

    @Test
    void roundTripsScopeAndKindAndANullCallId() throws Exception {
        JsonFileRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.json"));
        Redaction global = new Redaction("r1", RedactionScope.ALL, null, RedactionKind.RESPONSE_BODY_KEY, "data.accessToken", "t");

        adapter.save(global);

        assertThat(adapter.findAll()).containsExactly(global);
    }

    @Test
    void persistsAcrossAFreshAdapterInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("redactions.json");
        adapterFor(file).save(redaction("r1"));

        JsonFileRedactionsStoreAdapter secondInstance = adapterFor(file);

        assertThat(secondInstance.findAll()).extracting(Redaction::id).containsExactly("r1");
    }

    @Test
    void neverWritesAnythingBeyondTheRedactionsOwnFields() throws Exception {
        Path file = tempDir.resolve("redactions.json");
        JsonFileRedactionsStoreAdapter adapter = adapterFor(file);

        adapter.save(redaction("r1"));

        // A redaction stores only the NAME of what to mask - if a "value"/secret field is ever
        // added to the domain model, this assertion is the tripwire.
        assertThat(Files.readString(file))
                .contains("\"name\":\"authorization\"")
                .doesNotContain("value")
                .doesNotContain("lineText");
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingRedaction() throws Exception {
        JsonFileRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.json"));
        adapter.save(redaction("r1"));
        adapter.save(redaction("r2"));

        boolean removed = adapter.deleteById("r1");

        assertThat(removed).isTrue();
        assertThat(adapter.findAll()).extracting(Redaction::id).containsExactly("r2");
    }

    @Test
    void deleteByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        JsonFileRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.json"));
        adapter.save(redaction("r1"));

        assertThat(adapter.deleteById("missing")).isFalse();
        assertThat(adapter.findAll()).hasSize(1);
    }

    @Test
    void replaceAllOverwritesEveryRedaction() throws Exception {
        JsonFileRedactionsStoreAdapter adapter = adapterFor(tempDir.resolve("redactions.json"));
        adapter.save(redaction("r1"));
        adapter.save(redaction("r2"));

        Redaction only = new Redaction("r3", RedactionScope.ALL, null, RedactionKind.URL_PARAM, "api_key", "t");
        adapter.replaceAll(List.of(only));

        assertThat(adapter.findAll()).containsExactly(only);
    }

    @Test
    void createsMissingParentDirectoriesOnStartupCheck() throws Exception {
        Path nested = tempDir.resolve("nested/dir/redactions.json");
        JsonFileRedactionsStoreAdapter adapter = adapterFor(nested);

        adapter.checkStorageIsWritable();

        assertThat(nested.getParent()).exists();
        assertThat(adapter.findAll()).isEmpty();
    }
}
