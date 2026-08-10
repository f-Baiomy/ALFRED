package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileSessionCycleMetadataStoreAdapterTest {

    @TempDir
    Path tempDir;

    private JsonFileSessionCycleMetadataStoreAdapter adapterFor(Path file) throws Exception {
        JsonFileSessionCycleMetadataStoreAdapter adapter = new JsonFileSessionCycleMetadataStoreAdapter();
        Field field = JsonFileSessionCycleMetadataStoreAdapter.class.getDeclaredField("sessionCyclesFile");
        field.setAccessible(true);
        field.set(adapter, file.toString());
        return adapter;
    }

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro " + id, "2026-01-01T00:00:00Z", null, status);
    }

    @Test
    void findAllReturnsEmptyWhenTheFileDoesNotExistYet() throws Exception {
        JsonFileSessionCycleMetadataStoreAdapter adapter = adapterFor(tempDir.resolve("session-cycles.json"));

        assertThat(adapter.findAll()).isEmpty();
    }

    @Test
    void saveThenFindAllRoundTrips() throws Exception {
        JsonFileSessionCycleMetadataStoreAdapter adapter = adapterFor(tempDir.resolve("session-cycles.json"));

        adapter.save(cycle("c1", SessionCycleStatus.PAUSED));
        adapter.save(cycle("c2", SessionCycleStatus.RECORDING));

        assertThat(adapter.findAll()).extracting(SessionCycle::id).containsExactlyInAnyOrder("c1", "c2");
    }

    @Test
    void saveUpsertsAnExistingId() throws Exception {
        JsonFileSessionCycleMetadataStoreAdapter adapter = adapterFor(tempDir.resolve("session-cycles.json"));
        adapter.save(cycle("c1", SessionCycleStatus.PAUSED));

        adapter.save(cycle("c1", SessionCycleStatus.RECORDING));

        assertThat(adapter.findAll()).hasSize(1);
        assertThat(adapter.findById("c1")).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.RECORDING);
    }

    @Test
    void findByIdReturnsEmptyWhenMissing() throws Exception {
        JsonFileSessionCycleMetadataStoreAdapter adapter = adapterFor(tempDir.resolve("session-cycles.json"));

        assertThat(adapter.findById("missing")).isEmpty();
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingCycle() throws Exception {
        JsonFileSessionCycleMetadataStoreAdapter adapter = adapterFor(tempDir.resolve("session-cycles.json"));
        adapter.save(cycle("c1", SessionCycleStatus.PAUSED));
        adapter.save(cycle("c2", SessionCycleStatus.PAUSED));

        boolean removed = adapter.deleteById("c1");

        assertThat(removed).isTrue();
        assertThat(adapter.findAll()).extracting(SessionCycle::id).containsExactly("c2");
    }

    @Test
    void deleteByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        JsonFileSessionCycleMetadataStoreAdapter adapter = adapterFor(tempDir.resolve("session-cycles.json"));
        adapter.save(cycle("c1", SessionCycleStatus.PAUSED));

        assertThat(adapter.deleteById("missing")).isFalse();
        assertThat(adapter.findAll()).hasSize(1);
    }

    @Test
    void persistsAcrossAFreshAdapterInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("session-cycles.json");
        adapterFor(file).save(cycle("c1", SessionCycleStatus.PAUSED));

        JsonFileSessionCycleMetadataStoreAdapter secondInstance = adapterFor(file);

        assertThat(secondInstance.findAll()).extracting(SessionCycle::id).containsExactly("c1");
    }

    @Test
    void createsMissingParentDirectoriesOnStartupCheck() throws Exception {
        Path nested = tempDir.resolve("nested/dir/session-cycles.json");
        JsonFileSessionCycleMetadataStoreAdapter adapter = adapterFor(nested);

        adapter.checkStorageIsWritable();

        assertThat(nested.getParent()).exists();
        assertThat(adapter.findAll()).isEmpty();
    }
}
