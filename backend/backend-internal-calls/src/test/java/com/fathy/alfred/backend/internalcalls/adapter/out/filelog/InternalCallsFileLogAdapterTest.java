package com.fathy.alfred.backend.internalcalls.adapter.out.filelog;

import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.RequestData;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class InternalCallsFileLogAdapterTest {

    @TempDir
    Path tempDir;

    private static final int TEST_MAX_LIMIT = 500;

    private InternalCallsFileLogAdapter adapterFor(Path file) throws Exception {
        return adapterFor(file, TEST_MAX_LIMIT);
    }

    private InternalCallsFileLogAdapter adapterFor(Path file, int maxLimit) throws Exception {
        InternalCallsFileLogAdapter adapter = new InternalCallsFileLogAdapter();
        setField(adapter, "internalCallsFile", file.toString());
        setField(adapter, "maxLimit", maxLimit);
        return adapter;
    }

    private static void setField(InternalCallsFileLogAdapter adapter, String name, Object value) throws Exception {
        Field field = InternalCallsFileLogAdapter.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(adapter, value);
    }

    private static CallRecord prepared(String id) {
        return new CallRecord(id, "https://wildfly-proxy/x", "https://wildfly/x", "GET",
                new RequestData(null, null), "t", null, null, null, CallLifecycleStatus.IN_PROGRESS);
    }

    @Test
    void returnsEmptyListWhenTheFileDoesNotExist() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("missing.log"));

        assertThat(adapter.readAll()).isEmpty();
    }

    @Test
    void prepareWritesNothingToDiskUntilCompleteIsCalled() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"));
        String id = UUID.randomUUID().toString();

        adapter.prepare(prepared(id));

        assertThat(adapter.readAll()).isEmpty();
    }

    @Test
    void completeMergesTheOutcomeIntoThePreparedCallAndWritesItExactlyOnceRoundTrip() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"));
        String id = UUID.randomUUID().toString();
        adapter.prepare(prepared(id));

        boolean wasPending = adapter.complete(id, new ResponseData(200, null, "ok"), null, 42.0);

        assertThat(wasPending).isTrue();
        List<CallRecord> calls = adapter.readAll();
        assertThat(calls).hasSize(1);
        CallRecord saved = calls.get(0);
        assertThat(saved.id()).isEqualTo(id);
        assertThat(saved.originalUrl()).isEqualTo("https://wildfly-proxy/x");
        assertThat(saved.response().status()).isEqualTo(200);
        assertThat(saved.durationMs()).isEqualTo(42.0);
        assertThat(saved.state()).isEqualTo(CallLifecycleStatus.COMPLETED);
    }

    @Test
    void completeWithoutAMatchingPrepareStillPersistsWhateverThePayloadAloneOffers() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"));

        boolean wasPending = adapter.complete("never-prepared", new ResponseData(500, null, "oops"), null, 1.0);

        assertThat(wasPending).isFalse();
        assertThat(adapter.readAll()).hasSize(1);
        assertThat(adapter.readAll().get(0).response().status()).isEqualTo(500);
    }

    @Test
    void completeWithAnErrorRecordsErrorStateOnTheSavedCall() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"));
        String id = UUID.randomUUID().toString();
        adapter.prepare(prepared(id));

        adapter.complete(id, null, "connection refused", null);

        CallRecord saved = adapter.readAll().get(0);
        assertThat(saved.error()).isEqualTo("connection refused");
        assertThat(saved.response()).isNull();
        assertThat(saved.state()).isEqualTo(CallLifecycleStatus.ERROR);
    }

    @Test
    void dropsTheOldestLineOnceMaxLimitIsExceeded() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"), 3);

        for (String id : List.of("1", "2", "3", "4")) {
            adapter.prepare(prepared(id));
            adapter.complete(id, new ResponseData(200, null, "ok"), null, 1.0);
        }

        assertThat(adapter.readAll()).extracting(CallRecord::id).containsExactly("2", "3", "4");
    }

    @Test
    void persistsAcrossAFreshAdapterInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        String id = UUID.randomUUID().toString();
        InternalCallsFileLogAdapter first = adapterFor(file);
        first.prepare(prepared(id));
        first.complete(id, new ResponseData(200, null, "ok"), null, 1.0);

        InternalCallsFileLogAdapter secondInstance = adapterFor(file);

        assertThat(secondInstance.readAll()).extracting(CallRecord::id).containsExactly(id);
    }

    @Test
    void cacheIsInvalidatedWhenTheFileIsModifiedOutOfBand() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file);
        String id = UUID.randomUUID().toString();
        adapter.prepare(prepared(id));
        adapter.complete(id, new ResponseData(200, null, "ok"), null, 1.0);
        assertThat(adapter.readAll()).hasSize(1);

        // Simulate an out-of-band rewrite (manual edit, restored volume) with a distinct mtime.
        Files.writeString(file, """
                {"id":"manually-added","original_url":"https://wildfly-proxy/y","url":"https://wildfly/y","method":"POST","timestamp":"t2"}
                """);
        Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.from(Instant.now().plusSeconds(60)));

        List<CallRecord> calls = adapter.readAll();
        assertThat(calls).hasSize(1);
        assertThat(calls.get(0).id()).isEqualTo("manually-added");
    }

    @Test
    void queryFiltersBySessionOperationAndRequestIdSubstrings() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"));
        adapter.prepare(new CallRecord("call-1", "https://wildfly-proxy/x", "https://wildfly/x", "GET",
                null, "t", null, null, null, CallLifecycleStatus.IN_PROGRESS, "session-abc", "operation-xyz"));
        adapter.complete("call-1", new ResponseData(200, null, "ok"), null, 1.0);
        adapter.prepare(new CallRecord("call-2", "https://wildfly-proxy/y", "https://wildfly/y", "GET",
                null, "t", null, null, null, CallLifecycleStatus.IN_PROGRESS, "session-other", "operation-other"));
        adapter.complete("call-2", new ResponseData(200, null, "ok"), null, 1.0);

        var bySession = adapter.query("", "", "newest", 0, 10, true, "abc", "", "");
        var byOperation = adapter.query("", "", "newest", 0, 10, true, "", "xyz", "");
        var byRequestId = adapter.query("", "", "newest", 0, 10, true, "", "", "call-2");

        assertThat(bySession.items()).extracting(s -> s.id()).containsExactly("call-1");
        assertThat(byOperation.items()).extracting(s -> s.id()).containsExactly("call-1");
        assertThat(byRequestId.items()).extracting(s -> s.id()).containsExactly("call-2");
    }

    @Test
    void storageSizeBytesReturnsZeroWhenTheFileDoesNotExist() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("missing.log"));

        assertThat(adapter.storageSizeBytes()).isZero();
    }

    @Test
    void deleteAllRemovesTheFileAndClearsPendingCalls() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file);
        String id = UUID.randomUUID().toString();
        adapter.prepare(prepared(id));
        adapter.complete(id, new ResponseData(200, null, "ok"), null, 1.0);

        adapter.deleteAll();

        assertThat(file).doesNotExist();
        assertThat(adapter.readAll()).isEmpty();
        // A completion for the id prepared before deleteAll should now be "never prepared".
        assertThat(adapter.complete(id, new ResponseData(200, null, "ok"), null, 1.0)).isFalse();
    }
}
