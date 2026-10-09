package com.fathy.alfred.backend.internalcalls.adapter.out;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.RetentionPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.RequestData;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import com.fathy.alfred.backend.internalcalls.domain.model.WsMessage;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What every inbound call store must do, whichever it is (specs/013-inbound-calls-store, FR-010): the file store and
 * the SQLite store run these same scenarios, so "same answers with either store" is a test, not a hope.
 */
public abstract class InternalCallStoreContractTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    protected Path dir;

    private final List<CallLogPort> opened = new ArrayList<>();

    /** A store over {@code dir}; called again on the same {@code dir} it must see what the first one wrote. */
    protected abstract CallLogPort openStore(Path dir, int retentionRows, int wsMaxMessages) throws Exception;

    /** Releases a store (closes connections); a no-op for stores holding nothing open. */
    protected void closeStore(CallLogPort store) throws Exception {
    }

    @AfterEach
    void closeAll() throws Exception {
        for (CallLogPort store : opened) {
            closeStore(store);
        }
    }

    protected CallLogPort store(int retentionRows) throws Exception {
        return store(retentionRows, 1000);
    }

    protected CallLogPort store(int retentionRows, int wsMaxMessages) throws Exception {
        CallLogPort store = openStore(dir, retentionRows, wsMaxMessages);
        opened.add(store);
        return store;
    }

    protected static CallRecord prepared(String id, String url, String method, String at, String service) {
        return new CallRecord(id, "http://localhost:9001" + pathOf(url), url, method,
                new RequestData(Map.of("Content-Type", "application/json", "X-Trace", "t-" + id), "{\"req\":\"" + id + "\"}"), at,
                null, null, null, CallLifecycleStatus.IN_PROGRESS, "s-" + id, "o-" + id, service, null, null, null, null, null);
    }

    protected static CallRecord prepared(String id, String at) {
        return prepared(id, "http://wildfly:8080/app/" + id, "POST", at, "odeysys");
    }

    private static String pathOf(String url) {
        return url.replaceFirst("^https?://[^/]+", "");
    }

    protected static String at(int second) {
        return Instant.parse("2026-10-09T10:00:00Z").plusSeconds(second).toString();
    }

    protected static ResponseData ok(String body) {
        return new ResponseData(200, Map.of("Content-Type", "application/json"), body);
    }

    protected static void call(CallLogPort store, String id, int second, int status, double durationMs, String body) {
        store.prepare(prepared(id, at(second)));
        store.complete(id, new ResponseData(status, Map.of("X-Status", String.valueOf(status)), body), null, durationMs);
    }

    private static List<String> ids(CallLogPort store, String search, String sort) {
        return store.query(search, "", sort, 0, 1000, true, "", "", "", "").items().stream().map(CallSummary::id).toList();
    }

    // ------------------------------------------------------------------ lifecycle

    @Test
    void anEmptyStoreAnswersNothing() throws Exception {
        CallLogPort store = store(50);
        assertThat(store.query("", "", "newest", 0, 10, true, "", "", "", "").total()).isZero();
        assertThat(store.findById("nope")).isEmpty();
        assertThat(store.statusBreakdown().total()).isZero();
    }

    @Test
    void prepareThenCompleteStoresOneCompleteCall() throws Exception {
        CallLogPort store = store(50);
        store.prepare(prepared("a", at(1)));
        assertThat(store.complete("a", ok("{\"res\":1}"), null, 42.0)).isTrue();

        CallRecord found = store.findById("a").orElseThrow();
        assertThat(found.method()).isEqualTo("POST");
        assertThat(found.url()).isEqualTo("http://wildfly:8080/app/a");
        assertThat(found.originalUrl()).isEqualTo("http://localhost:9001/app/a");
        assertThat(found.timestamp()).isEqualTo(at(1));
        assertThat(found.serviceName()).isEqualTo("odeysys");
        assertThat(found.sessionId()).isEqualTo("s-a");
        assertThat(found.operationId()).isEqualTo("o-a");
        assertThat(found.request().headers()).containsEntry("X-Trace", "t-a");
        assertThat(found.request().body()).isEqualTo("{\"req\":\"a\"}");
        assertThat(found.response().status()).isEqualTo(200);
        assertThat(found.response().body()).isEqualTo("{\"res\":1}");
        assertThat(found.durationMs()).isEqualTo(42.0);
        assertThat(found.state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(store.readAll()).extracting(CallRecord::id).containsExactly("a");
    }

    @Test
    void aFailedCallIsStoredInErrorState() throws Exception {
        CallLogPort store = store(50);
        store.prepare(prepared("e", at(1)));
        store.complete("e", null, "upstream reset", 3.0);
        CallRecord found = store.findById("e").orElseThrow();
        assertThat(found.state()).isEqualTo(CallLifecycleStatus.ERROR);
        assertThat(found.error()).isEqualTo("upstream reset");
    }

    @Test
    void aCompletionWithoutItsPrepareIsStoredFromWhatItCarries() throws Exception {
        CallLogPort store = store(50);
        CallRecord known = new CallRecord("late", "http://localhost:9001/x", "http://wildfly:8080/x", "OPTIONS", null, at(5),
                null, null, null, null, "s1", "o1", "odeysys", null, null, null, null, null);

        assertThat(store.complete("late", ok(""), null, 29.9, null, null, known)).isFalse();

        CallRecord found = store.findById("late").orElseThrow();
        assertThat(found.method()).isEqualTo("OPTIONS");
        assertThat(found.url()).isEqualTo("http://wildfly:8080/x");
        assertThat(found.timestamp()).isEqualTo(at(5));
        assertThat(found.serviceName()).isEqualTo("odeysys");
        assertThat(found.request()).isNull();
        assertThat(found.response().status()).isEqualTo(200);
    }

    @Test
    void aCompletionWithNeitherPrepareNorIdentityIsStillStored() throws Exception {
        CallLogPort store = store(50);
        assertThat(store.complete("bare", ok("x"), null, 1.0)).isFalse();
        assertThat(store.findById("bare")).isPresent();
    }

    @Test
    void aPrepareArrivingAfterItsCompletionFillsInTheRequest() throws Exception {
        CallLogPort store = store(50);
        store.complete("late", new ResponseData(204, null, null), null, 29.9, null, null,
                new CallRecord("late", null, "http://wildfly:8080/app/late", "POST", null, at(1), null, null, null, null));

        assertThat(store.prepareOrMerge(prepared("late", at(1)))).isTrue();

        CallRecord merged = store.findById("late").orElseThrow();
        assertThat(merged.request().headers()).containsEntry("X-Trace", "t-late");
        assertThat(merged.response().status()).isEqualTo(204);
        assertThat(merged.durationMs()).isEqualTo(29.9);
        assertThat(merged.state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(store.readAll()).extracting(CallRecord::id).containsExactly("late");
    }

    @Test
    void repeatedReportsKeepOneRowAndItsOutcome() throws Exception {
        // The proxy retries a report whose answer it never got; the first attempt may already be stored.
        CallLogPort store = store(50);
        store.prepare(prepared("x", at(1)));
        assertThat(store.complete("x", ok("first"), null, 5.0)).isTrue();

        store.complete("x", ok("first"), null, 5.0);
        store.prepareOrMerge(prepared("x", at(1)));
        store.prepareOrMerge(prepared("x", at(1)));

        assertThat(store.readAll()).extracting(CallRecord::id).containsExactly("x");
        CallRecord found = store.findById("x").orElseThrow();
        assertThat(found.state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(found.response().body()).isEqualTo("first");
    }

    @Test
    void anInterceptionRecordRoundTrips() throws Exception {
        CallLogPort store = store(50);
        CallInterception interception = new CallInterception(
                List.of(new CallInterception.Applied("r1", "Slow it", "DELAY", "500 ms")), null, null, null, null);
        store.prepare(prepared("i", at(1)));
        store.complete("i", ok("x"), null, 500.0, interception);
        assertThat(store.findById("i").orElseThrow().interception().applied())
                .extracting(CallInterception.Applied::action).containsExactly("DELAY");
    }

    @Test
    void callsSurviveReopeningTheStore() throws Exception {
        CallLogPort first = store(50);
        call(first, "a", 1, 200, 1.0, "one");
        closeStore(first);
        opened.remove(first);

        CallLogPort second = store(50);
        assertThat(second.findById("a").orElseThrow().response().body()).isEqualTo("one");
    }

    @Test
    void deleteAllEmptiesTheStore() throws Exception {
        CallLogPort store = store(50);
        call(store, "a", 1, 200, 1.0, "one");
        store.deleteAll();
        assertThat(store.readAll()).isEmpty();
        assertThat(store.findById("a")).isEmpty();
    }

    // ------------------------------------------------------------------ retention

    @Test
    void retentionKeepsTheNewestCalls() throws Exception {
        CallLogPort store = store(3);
        for (int i = 1; i <= 6; i++) {
            call(store, "c" + i, i, 200, i, "b" + i);
        }
        assertThat(ids(store, "", "oldest")).containsExactly("c4", "c5", "c6");
        assertThat(store.findById("c1")).isEmpty();
    }

    @Test
    void retentionCanBeLoweredWhileRunning() throws Exception {
        CallLogPort store = store(10);
        for (int i = 1; i <= 6; i++) {
            call(store, "c" + i, i, 200, i, "b" + i);
        }
        ((RetentionPort) store).setRetentionRows(2);
        call(store, "c7", 7, 200, 7, "b7");
        assertThat(ids(store, "", "oldest")).containsExactly("c6", "c7");
    }

    // ------------------------------------------------------------------ queries

    @Test
    void sortsAsTheLiveListExpects() throws Exception {
        CallLogPort store = store(50);
        call(store, "a", 1, 200, 30.0, "x");
        call(store, "b", 2, 500, 10.0, "x");
        call(store, "c", 3, 404, 20.0, "x");
        assertThat(ids(store, "", "newest")).containsExactly("c", "b", "a");
        assertThat(ids(store, "", "oldest")).containsExactly("a", "b", "c");
        assertThat(ids(store, "", "slowest")).containsExactly("a", "c", "b");
        assertThat(ids(store, "", "fastest")).containsExactly("b", "c", "a");
        assertThat(ids(store, "", "status")).containsExactly("b", "c", "a");
    }

    @Test
    void searchFindsTextInMethodUrlStatusHeadersAndBodiesCaseInsensitively() throws Exception {
        CallLogPort store = store(50);
        call(store, "a", 1, 200, 1.0, "{\"pnr\":\"NeedleInResponse\"}");
        call(store, "b", 2, 418, 1.0, "plain");
        call(store, "c", 3, 200, 1.0, "plain");
        assertThat(ids(store, "needleinresponse", "oldest")).containsExactly("a");
        assertThat(ids(store, "418", "oldest")).containsExactly("b");
        assertThat(ids(store, "t-c", "oldest")).containsExactly("c");          // a request header value
        assertThat(ids(store, "\"req\":\"b\"", "oldest")).containsExactly("b"); // the request body
        assertThat(ids(store, "app/c", "oldest")).containsExactly("c");         // the URL
        assertThat(ids(store, "zz", "oldest")).isEmpty();                       // shorter than a trigram
        assertThat(ids(store, "po", "oldest")).containsExactly("a", "b", "c");  // the method, two letters
    }

    @Test
    void filtersAndPaginationCombine() throws Exception {
        CallLogPort store = store(50);
        store.prepare(prepared("a", "http://wildfly:8080/a", "GET", at(1), "odeysys"));
        store.complete("a", ok("x"), null, 1.0);
        store.prepare(prepared("b", "http://wildfly:8080/b", "GET", at(2), "core-service"));
        store.complete("b", ok("x"), null, 1.0);
        store.prepare(prepared("c", "http://wildfly:8080/c", "GET", at(3), null));
        store.complete("c", ok("x"), null, 1.0);

        assertThat(store.query("", "", "oldest", 0, 10, true, "s-b", "", "", "").items()).extracting(CallSummary::id).containsExactly("b");
        assertThat(store.query("", "", "oldest", 0, 10, true, "", "o-a", "", "").items()).extracting(CallSummary::id).containsExactly("a");
        assertThat(store.query("", "", "oldest", 0, 10, true, "", "", "C", "").items()).extracting(CallSummary::id).containsExactly("c");
        assertThat(store.query("", "", "oldest", 0, 10, true, "", "", "", "odeysys, unknown").items())
                .extracting(CallSummary::id).containsExactly("a", "c");
        var page = store.query("", "", "oldest", 1, 1, true, "", "", "", "");
        assertThat(page.total()).isEqualTo(3);
        assertThat(page.items()).extracting(CallSummary::id).containsExactly("b");
    }

    @Test
    void reliveRunsAreFoundFilteredAndDeleted() throws Exception {
        CallLogPort store = store(50);
        store.prepare(withRelive(prepared("r1", at(1)), "{\"runId\":\"run-1\",\"stepKey\":\"s\"}"));
        store.complete("r1", ok("x"), null, 1.0);
        store.prepare(withRelive(prepared("r2", at(2)), "{\"ambiguousRunIds\":[\"run-1\",\"run-2\"]}"));
        store.complete("r2", ok("x"), null, 1.0);
        call(store, "plain", 3, 200, 1.0, "x");

        assertThat(store.findByReliveRunId("run-1")).extracting(CallRecord::id).containsExactly("r1", "r2");
        assertThat(store.query("", "", "oldest", 0, 10, true, "", "", "", "", "exclude").items())
                .extracting(CallSummary::id).containsExactly("plain");
        assertThat(store.query("", "", "oldest", 0, 10, true, "", "", "", "", "run-2").items())
                .extracting(CallSummary::id).containsExactly("r2");

        store.prepare(withRelive(prepared("inflight", at(4)), "{\"runId\":\"run-1\"}"));
        assertThat(store.deleteByReliveRunIds(List.of("run-1"))).isGreaterThanOrEqualTo(2);
        // A call of the deleted run still in flight must not come back when it completes.
        assertThat(store.complete("inflight", ok("x"), null, 1.0)).isFalse();
        assertThat(ids(store, "", "oldest")).containsExactly("plain");
    }

    @Test
    void resolvedCallsInATimeRangeAreFound() throws Exception {
        CallLogPort store = store(50);
        call(store, "early", 1, 200, 1.0, "x");
        call(store, "inside", 100, 200, 1.0, "x");
        store.prepare(prepared("running", at(110)));
        List<CallRecord> found = store.findResolvedInRange(Instant.parse(at(50)), Instant.parse(at(200)), "", "", "", "", "");
        assertThat(found).extracting(CallRecord::id).containsExactly("inside");
    }

    @Test
    void recentRequestHeadersAreNewestFirstForTheHost() throws Exception {
        CallLogPort store = store(50);
        call(store, "a", 1, 200, 1.0, "x");
        store.prepare(prepared("other", "http://elsewhere:9000/x", "GET", at(2), "odeysys"));
        store.complete("other", ok("x"), null, 1.0);
        call(store, "b", 3, 200, 1.0, "x");
        assertThat(store.recentRequestHeaders("wildfly", 10)).extracting(r -> r.callId()).containsExactly("b", "a");
    }

    @Test
    void baselineAndStatusBreakdownCountResolvedCalls() throws Exception {
        CallLogPort store = store(50);
        String url = "http://wildfly:8080/same";
        for (int i = 1; i <= 4; i++) {
            store.prepare(prepared("b" + i, url, "GET", at(i), "odeysys"));
            store.complete("b" + i, new ResponseData(i == 4 ? 503 : 200, null, "x"), null, i * 10.0);
        }
        store.prepare(prepared("open", url, "GET", at(9), "odeysys"));

        var baseline = store.baselineFor(url);
        assertThat(baseline.sampleSize()).isEqualTo(4);
        assertThat(baseline.p50Ms()).isEqualTo(30.0);
        var breakdown = store.statusBreakdown();
        assertThat(breakdown.ok()).isEqualTo(3);
        assertThat(breakdown.serverError()).isEqualTo(1);
    }

    @Test
    void webSocketMessagesAreCappedKeepingTheNewest() throws Exception {
        CallLogPort store = store(50, 3);
        call(store, "ws", 1, 101, 1.0, null);
        List<WsMessage> batch = new ArrayList<>();
        for (int i = 1; i <= 5; i++) {
            batch.add(new WsMessage(i, "server", 1000L + i, "text", "m" + i, null, null, null));
        }
        store.appendWsMessages("ws", batch, false, null);
        var page = store.wsMessages("ws", 0, 10);
        assertThat(page.messages()).extracting(WsMessage::content).containsExactly("m3", "m4", "m5");
        assertThat(page.dropped()).isEqualTo(2);
    }

    private static CallRecord withRelive(CallRecord call, String json) throws Exception {
        return new CallRecord(call.id(), call.originalUrl(), call.url(), call.method(), call.request(), call.timestamp(),
                call.durationMs(), call.response(), call.error(), call.state(), call.sessionId(), call.operationId(),
                call.serviceName(), call.interception(), call.resendOf(), call.resendEdits(), JSON.readTree(json), call.reachedUpstream());
    }
}
