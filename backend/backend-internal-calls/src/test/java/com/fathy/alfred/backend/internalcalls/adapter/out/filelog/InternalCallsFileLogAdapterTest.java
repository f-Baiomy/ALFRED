package com.fathy.alfred.backend.internalcalls.adapter.out.filelog;

import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
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

    private static final int TEST_RETENTION_ROWS = 500;

    private InternalCallsFileLogAdapter adapterFor(Path file) throws Exception {
        return adapterFor(file, TEST_RETENTION_ROWS);
    }

    private InternalCallsFileLogAdapter adapterFor(Path file, int retentionRows) throws Exception {
        InternalCallsFileLogAdapter adapter = new InternalCallsFileLogAdapter();
        setField(adapter, "internalCallsFile", file.toString());
        setField(adapter, "retentionRows", retentionRows);
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
    void resendLinkageSurvivesPrepareCompleteAndAFileReload() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file);
        String id = UUID.randomUUID().toString();
        CallRecord partial = prepared(id).withResend("orig-1", "{\"headers\":[\"x-a\"]}");
        adapter.prepare(partial);

        adapter.complete(id, new ResponseData(200, null, "ok"), null, 42.0);

        InternalCallsFileLogAdapter reloaded = adapterFor(file);
        CallRecord saved = reloaded.readAll().get(0);
        assertThat(saved.resendOf()).isEqualTo("orig-1");
        assertThat(saved.resendEdits()).isEqualTo("{\"headers\":[\"x-a\"]}");
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
    void dropsTheOldestLineOnceRetentionRowsIsExceeded() throws Exception {
        // Retention is its own property now. It used to be alfred.internal-calls.max-limit, which
        // is the largest PAGE the API serves - so the store could never hold more calls than one
        // request was allowed to return, and inbound calls were evicted within minutes.
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"), 3);

        for (String id : List.of("1", "2", "3", "4")) {
            adapter.prepare(prepared(id));
            adapter.complete(id, new ResponseData(200, null, "ok"), null, 1.0);
        }

        assertThat(adapter.readAll()).extracting(CallRecord::id).containsExactly("2", "3", "4");
    }

    /**
     * The regression this guards: save() used to rebuild the ENTIRE file in memory per call, which
     * at the default 1500-row cap and a real ~33 KB call is 150-250 MB of transient allocation to
     * record one call. Under concurrent inbound traffic the backend OOMed and dropped calls
     * silently - measured at 4 of 60 stored, with 504 OutOfMemoryErrors. Appending is what makes
     * the per-call cost flat, so assert the file is genuinely being APPENDED to: everything already
     * written stays byte-for-byte untouched, which a full rewrite could never guarantee.
     */
    @Test
    void appendsANewCallRatherThanRewritingTheWholeFile() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file, 500);

        adapter.prepare(prepared("first"));
        adapter.complete("first", new ResponseData(200, null, "ok"), null, 1.0);
        String afterFirst = Files.readString(file);

        adapter.prepare(prepared("second"));
        adapter.complete("second", new ResponseData(200, null, "ok"), null, 1.0);
        String afterSecond = Files.readString(file);

        assertThat(afterSecond).startsWith(afterFirst);
        assertThat(afterSecond.length()).isGreaterThan(afterFirst.length());
        assertThat(adapter.readAll()).extracting(CallRecord::id).containsExactly("first", "second");
    }

    /**
     * Appending means the file is allowed to run past the cap until compaction reclaims it - but a
     * READ must never see more than the cap, or the ring buffer would only be honoured at whatever
     * moment compaction last happened.
     */
    @Test
    void servesOnlyTheRetainedTailWhileTheFileIsStillCarryingSlack() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file, 3);

        for (int i = 1; i <= 10; i++) {
            adapter.prepare(prepared(String.valueOf(i)));
            adapter.complete(String.valueOf(i), new ResponseData(200, null, "ok"), null, 1.0);
        }

        // Reads honour the cap exactly...
        assertThat(adapter.readAll()).extracting(CallRecord::id).containsExactly("8", "9", "10");
        // ...while the file itself is still holding the un-compacted slack.
        assertThat(Files.readAllLines(file).size()).isGreaterThan(3);
        // And a cold adapter over that same file agrees, rather than replaying the slack.
        assertThat(adapterFor(file, 3).readAll()).extracting(CallRecord::id).containsExactly("8", "9", "10");
    }

    /** Once the slack is used up the file is compacted back down, so appending can't grow it without bound. */
    @Test
    void compactsTheFileBackDownOnceItOutgrowsTheSlack() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file, 4);
        // retention 4 -> threshold is 4 + max(4/2, 50) = 54, so 60 calls must force a compaction.
        for (int i = 1; i <= 60; i++) {
            adapter.prepare(prepared(String.valueOf(i)));
            adapter.complete(String.valueOf(i), new ResponseData(200, null, "ok"), null, 1.0);
        }

        assertThat(Files.readAllLines(file).size()).isLessThanOrEqualTo(54);
        assertThat(adapter.readAll()).extracting(CallRecord::id).containsExactly("57", "58", "59", "60");
        // No temp file left behind by the compaction's write-then-move.
        assertThat(Files.list(tempDir).map(p -> p.getFileName().toString()).toList())
                .containsExactly("internal-calls.log");
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

        var bySession = adapter.query("", "", "newest", 0, 10, true, "abc", "", "", "");
        var byOperation = adapter.query("", "", "newest", 0, 10, true, "", "xyz", "", "");
        var byRequestId = adapter.query("", "", "newest", 0, 10, true, "", "", "call-2", "");

        assertThat(bySession.items()).extracting(s -> s.id()).containsExactly("call-1");
        assertThat(byOperation.items()).extracting(s -> s.id()).containsExactly("call-1");
        assertThat(byRequestId.items()).extracting(s -> s.id()).containsExactly("call-2");
    }

    @Test
    void queryFiltersByServiceNamesTreatingMissingAsUnknown() throws Exception {
        InternalCallsFileLogAdapter adapter = adapterFor(tempDir.resolve("internal-calls.log"));
        adapter.prepare(new CallRecord("call-1", "https://wildfly-proxy/x", "https://wildfly/x", "GET",
                null, "t", null, null, null, CallLifecycleStatus.IN_PROGRESS, null, null, "odeysys"));
        adapter.complete("call-1", new ResponseData(200, null, "ok"), null, 1.0);
        adapter.prepare(new CallRecord("call-2", "https://wildfly-proxy/y", "https://wildfly/y", "GET",
                null, "t", null, null, null, CallLifecycleStatus.IN_PROGRESS, null, null, null));
        adapter.complete("call-2", new ResponseData(200, null, "ok"), null, 1.0);

        var byOdeysys = adapter.query("", "", "newest", 0, 10, true, "", "", "", "odeysys");
        var byUnknown = adapter.query("", "", "newest", 0, 10, true, "", "", "", "unknown");
        var unfiltered = adapter.query("", "", "newest", 0, 10, true, "", "", "", "");

        assertThat(byOdeysys.items()).extracting(s -> s.id()).containsExactly("call-1");
        assertThat(byUnknown.items()).extracting(s -> s.id()).containsExactly("call-2");
        assertThat(unfiltered.items()).extracting(s -> s.id()).containsExactlyInAnyOrder("call-1", "call-2");
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

    @Test
    void anInterceptionRecordRoundTripsThroughTheFile() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file);
        String id = "c-intercepted";
        adapter.prepare(prepared(id));
        CallInterception interception = new CallInterception(
                List.of(new CallInterception.Applied("r1", "Rewrite", "SET_RESPONSE_STATUS", "503")),
                null, new CallInterception.Http(200, "OK", null, null, java.util.Map.of(), "{}"),
                null, new CallInterception.Http(503, "Service Unavailable", null, null, java.util.Map.of(), "{}"));

        adapter.complete(id, new ResponseData(503, null, "{}"), null, 12.0, interception);

        // A fresh adapter reads the file itself, not this one's cache.
        CallRecord reread = adapterFor(file).readAll().get(0);
        assertThat(reread.interception()).isNotNull();
        assertThat(reread.interception().applied()).extracting(CallInterception.Applied::action)
                .containsExactly("SET_RESPONSE_STATUS");
        assertThat(reread.interception().originalResponse().status()).isEqualTo(200);
    }

    @Test
    void anUntouchedCallsLineCarriesNoInterceptionKey() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        InternalCallsFileLogAdapter adapter = adapterFor(file);
        adapter.prepare(prepared("plain"));
        adapter.complete("plain", new ResponseData(200, null, "ok"), null, 5.0, null);

        assertThat(Files.readString(file)).doesNotContain("interception");
    }

    @Test
    void aLineWrittenBeforeTheFieldExistedReadsAsNoInterception() throws Exception {
        Path file = tempDir.resolve("internal-calls.log");
        Files.writeString(file, "{\"id\":\"old\",\"url\":\"http://x/\",\"method\":\"GET\",\"state\":\"COMPLETED\"}\n");

        assertThat(adapterFor(file).readAll().get(0).interception()).isNull();
    }
}
