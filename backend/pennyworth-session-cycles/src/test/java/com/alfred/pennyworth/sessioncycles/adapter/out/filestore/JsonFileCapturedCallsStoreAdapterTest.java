package com.alfred.pennyworth.sessioncycles.adapter.out.filestore;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.alfred.pennyworth.sessioncycles.domain.model.CapturedCall;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

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
        return new CallRecord("https://a.com-proxy/x", "https://a.com/x", method, null, "t", 1.0, null, null);
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
}
