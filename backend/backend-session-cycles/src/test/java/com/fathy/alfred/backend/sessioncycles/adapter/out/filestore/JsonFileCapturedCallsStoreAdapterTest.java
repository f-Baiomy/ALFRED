package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileCapturedCallsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private JsonFileCapturedCallsStoreAdapter adapterFor(Path dir) throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = new JsonFileCapturedCallsStoreAdapter();
        Field field = JsonFileCapturedCallsStoreAdapter.class.getDeclaredField("sessionCyclesDir");
        field.setAccessible(true);
        field.set(adapter, dir.toString());
        return adapter;
    }

    private static CallRecord call(String method) {
        return new CallRecord("id-" + method, "https://a.com-proxy/x", "https://a.com/x", method, null, "t", 1.0, null, null);
    }

    @Test
    void findAllByCycleReturnsEmptyWhenTheFileDoesNotExistYet() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);

        assertThat(adapter.findAllByCycle("missing-cycle")).isEmpty();
    }

    @Test
    void appendThenFindAllByCycleRoundTrips() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);

        adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-1", call("POST"));

        assertThat(adapter.findAllByCycle("cycle-1"))
                .extracting(c -> c.call().method())
                .containsExactly("GET", "POST");
    }

    @Test
    void appendAssignsEachCapturedCallItsOwnId() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);

        CapturedCall first = adapter.append("cycle-1", call("GET"));
        CapturedCall second = adapter.append("cycle-1", call("POST"));

        assertThat(first.id()).isNotBlank().isNotEqualTo(second.id());
    }

    @Test
    void cyclesHaveIndependentFiles() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);

        adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-2", call("POST"));

        assertThat(adapter.findAllByCycle("cycle-1")).extracting(c -> c.call().method()).containsExactly("GET");
        assertThat(adapter.findAllByCycle("cycle-2")).extracting(c -> c.call().method()).containsExactly("POST");
    }

    @Test
    void removeByIdRemovesOnlyTheMatchingCall() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);
        CapturedCall first = adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-1", call("POST"));

        boolean removed = adapter.removeById("cycle-1", first.id());

        assertThat(removed).isTrue();
        assertThat(adapter.findAllByCycle("cycle-1")).extracting(c -> c.call().method()).containsExactly("POST");
    }

    @Test
    void removeByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);
        adapter.append("cycle-1", call("GET"));

        assertThat(adapter.removeById("cycle-1", "missing")).isFalse();
        assertThat(adapter.findAllByCycle("cycle-1")).hasSize(1);
    }

    @Test
    void deleteAllForCycleDeletesTheFile() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);
        adapter.append("cycle-1", call("GET"));

        adapter.deleteAllForCycle("cycle-1");

        assertThat(Files.exists(tempDir.resolve("cycle-1.json"))).isFalse();
        assertThat(adapter.findAllByCycle("cycle-1")).isEmpty();
    }

    @Test
    void deleteAllForCycleIsANoOpWhenTheFileNeverExisted() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);

        adapter.deleteAllForCycle("never-existed");
    }

    @Test
    void cacheByCycleNeverGrowsPastItsMaxSizeNoMatterHowManyCyclesAreTouched() throws Exception {
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);
        int max = maxCachedCycles();

        for (int i = 0; i < max + 5; i++) {
            adapter.append("cycle-" + i, call("GET"));
        }

        assertThat(cacheSize(adapter)).isLessThanOrEqualTo(max);
        // Evicting a cycle from the cache must not lose data - the next read just re-parses its
        // file from disk instead of trusting a cached snapshot.
        assertThat(adapter.findAllByCycle("cycle-0")).extracting(c -> c.call().method()).containsExactly("GET");
    }

    private static int maxCachedCycles() throws Exception {
        Field field = JsonFileCapturedCallsStoreAdapter.class.getDeclaredField("MAX_CACHED_CYCLES");
        field.setAccessible(true);
        return field.getInt(null);
    }

    private static int cacheSize(JsonFileCapturedCallsStoreAdapter adapter) throws Exception {
        Field field = JsonFileCapturedCallsStoreAdapter.class.getDeclaredField("cacheByCycle");
        field.setAccessible(true);
        return ((Map<?, ?>) field.get(adapter)).size();
    }

    @Test
    void backfillsAMissingIdOnTheEmbeddedCallAndPersistsIt() throws Exception {
        Files.writeString(tempDir.resolve("cycle-1.json"), """
                [{"id":"captured-1","capturedAt":"2026-01-01T00:00:00Z","call":{"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}}]
                """);
        JsonFileCapturedCallsStoreAdapter adapter = adapterFor(tempDir);

        String firstReadId = adapter.findAllByCycle("cycle-1").get(0).call().id();
        assertThat(firstReadId).isNotBlank();

        JsonFileCapturedCallsStoreAdapter freshAdapter = adapterFor(tempDir);
        String secondReadId = freshAdapter.findAllByCycle("cycle-1").get(0).call().id();
        assertThat(secondReadId).isEqualTo(firstReadId);
    }
}
