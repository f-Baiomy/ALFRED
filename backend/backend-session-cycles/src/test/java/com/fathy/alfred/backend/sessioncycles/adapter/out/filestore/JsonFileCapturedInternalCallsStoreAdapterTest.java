package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCall;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileCapturedInternalCallsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private JsonFileCapturedInternalCallsStoreAdapter adapterFor(Path dir) throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = new JsonFileCapturedInternalCallsStoreAdapter();
        Field field = JsonFileCapturedInternalCallsStoreAdapter.class.getDeclaredField("sessionCyclesDir");
        field.setAccessible(true);
        field.set(adapter, dir.toString());
        return adapter;
    }

    private static CallRecord call(String method) {
        return new CallRecord("id-" + method, "https://wildfly-proxy/x", "https://wildfly/x", method, null, "t", 1.0, null, null);
    }

    @Test
    void findAllByCycleReturnsEmptyWhenTheFileDoesNotExistYet() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);

        assertThat(adapter.findAllByCycle("missing-cycle")).isEmpty();
    }

    @Test
    void appendThenFindAllByCycleRoundTrips() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);

        adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-1", call("POST"));

        assertThat(adapter.findAllByCycle("cycle-1"))
                .extracting(c -> c.call().method())
                .containsExactly("GET", "POST");
    }

    @Test
    void appendAssignsEachCapturedCallItsOwnId() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);

        CapturedInternalCall first = adapter.append("cycle-1", call("GET"));
        CapturedInternalCall second = adapter.append("cycle-1", call("POST"));

        assertThat(first.id()).isNotBlank().isNotEqualTo(second.id());
    }

    @Test
    void cyclesHaveIndependentFiles() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);

        adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-2", call("POST"));

        assertThat(adapter.findAllByCycle("cycle-1")).extracting(c -> c.call().method()).containsExactly("GET");
        assertThat(adapter.findAllByCycle("cycle-2")).extracting(c -> c.call().method()).containsExactly("POST");
    }

    @Test
    void removeByIdRemovesOnlyTheMatchingCall() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        CapturedInternalCall first = adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-1", call("POST"));

        boolean removed = adapter.removeById("cycle-1", first.id());

        assertThat(removed).isTrue();
        assertThat(adapter.findAllByCycle("cycle-1")).extracting(c -> c.call().method()).containsExactly("POST");
    }

    @Test
    void removeByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        adapter.append("cycle-1", call("GET"));

        assertThat(adapter.removeById("cycle-1", "missing")).isFalse();
        assertThat(adapter.findAllByCycle("cycle-1")).hasSize(1);
    }

    @Test
    void removeByIdsRemovesOnlyTheMatchingCallsAndCountsThem() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        CapturedInternalCall first = adapter.append("cycle-1", call("GET"));
        CapturedInternalCall second = adapter.append("cycle-1", call("POST"));
        adapter.append("cycle-1", call("DELETE"));

        int removed = adapter.removeByIds("cycle-1", List.of(first.id(), second.id(), "missing"));

        assertThat(removed).isEqualTo(2);
        assertThat(adapter.findAllByCycle("cycle-1")).extracting(c -> c.call().method()).containsExactly("DELETE");
    }

    @Test
    void removeByIdsReturnsZeroWhenNoneOfTheIdsMatch() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        adapter.append("cycle-1", call("GET"));

        assertThat(adapter.removeByIds("cycle-1", List.of("missing-1", "missing-2"))).isEqualTo(0);
        assertThat(adapter.findAllByCycle("cycle-1")).hasSize(1);
    }

    @Test
    void deleteAllForCycleDeletesTheFile() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        adapter.append("cycle-1", call("GET"));

        adapter.deleteAllForCycle("cycle-1");

        assertThat(Files.exists(tempDir.resolve("cycle-1.json"))).isFalse();
        assertThat(adapter.findAllByCycle("cycle-1")).isEmpty();
    }

    @Test
    void deleteAllForCycleIsANoOpWhenTheFileNeverExisted() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);

        adapter.deleteAllForCycle("never-existed");
    }

    @Test
    void findByCallIdLooksUpByTheUnderlyingCallRecordId() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        CallRecord underlying = call("GET");
        adapter.append("cycle-1", underlying);

        assertThat(adapter.findByCallId("cycle-1", underlying.id())).isPresent();
        assertThat(adapter.findByCallId("cycle-1", "missing")).isEmpty();
    }

    @Test
    void deleteAllRemovesEveryCyclesFile() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-2", call("POST"));

        adapter.deleteAll();

        assertThat(adapter.findAllByCycle("cycle-1")).isEmpty();
        assertThat(adapter.findAllByCycle("cycle-2")).isEmpty();
    }

    @Test
    void countAllSumsCapturedCallsAcrossEveryCycle() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
        adapter.append("cycle-1", call("GET"));
        adapter.append("cycle-1", call("POST"));
        adapter.append("cycle-2", call("DELETE"));

        assertThat(adapter.countAll()).isEqualTo(3);
    }

    @Test
    void cacheByCycleNeverGrowsPastItsMaxSizeNoMatterHowManyCyclesAreTouched() throws Exception {
        JsonFileCapturedInternalCallsStoreAdapter adapter = adapterFor(tempDir);
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
        Field field = JsonFileCapturedInternalCallsStoreAdapter.class.getDeclaredField("MAX_CACHED_CYCLES");
        field.setAccessible(true);
        return field.getInt(null);
    }

    private static int cacheSize(JsonFileCapturedInternalCallsStoreAdapter adapter) throws Exception {
        Field field = JsonFileCapturedInternalCallsStoreAdapter.class.getDeclaredField("cacheByCycle");
        field.setAccessible(true);
        return ((Map<?, ?>) field.get(adapter)).size();
    }
}
