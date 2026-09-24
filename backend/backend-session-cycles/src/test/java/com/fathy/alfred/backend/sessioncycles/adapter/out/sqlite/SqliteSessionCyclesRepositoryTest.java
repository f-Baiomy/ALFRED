package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.domain.model.CallInterception;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallTiming;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.LegacyCycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteSessionCyclesRepositoryTest {

    @TempDir
    Path tempDir;

    private final List<SqliteSessionCyclesRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteSessionCyclesRepository::close);
        Thread.sleep(50);
    }

    private SqliteSessionCyclesRepository repositoryFor(Path dbFile) throws Exception {
        SqliteSessionCyclesRepository repository = new SqliteSessionCyclesRepository();
        Field field = SqliteSessionCyclesRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro", "2026-01-01T00:00:00Z", "profile-1", status);
    }

    private static CallRecord call(String url, String timestamp) {
        return new CallRecord(UUID.randomUUID().toString(), url, url, "GET", null, timestamp, 1.0, null, null);
    }

    @Test
    void saveThenFindByIdRoundTripsACycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        SessionCycle cycle = cycle("c1", SessionCycleStatus.PAUSED);

        repo.saveCycle(cycle);

        Optional<SessionCycle> found = repo.findCycleById("c1");
        assertThat(found).contains(cycle);
    }

    @Test
    void saveUpsertsAnExistingCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.saveCycle(cycle("c1", SessionCycleStatus.PAUSED));

        repo.saveCycle(cycle("c1", SessionCycleStatus.RECORDING));

        assertThat(repo.findAllCycles()).hasSize(1);
        assertThat(repo.findCycleById("c1")).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.RECORDING);
    }

    @Test
    void deleteCycleByIdRemovesOnlyThatCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.saveCycle(cycle("c1", SessionCycleStatus.PAUSED));
        repo.saveCycle(cycle("c2", SessionCycleStatus.PAUSED));

        assertThat(repo.deleteCycleById("c1")).isTrue();

        assertThat(repo.findAllCycles()).extracting(SessionCycle::id).containsExactly("c2");
        assertThat(repo.deleteCycleById("missing")).isFalse();
    }

    @Test
    void appendThenFindAllByCycleRoundTripsACapturedCall() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord call = call("https://a.com/x", "t1");

        CapturedCall captured = repo.append("c1", call);

        assertThat(captured.id()).isNotBlank();
        List<CapturedCall> found = repo.findAllByCycle("c1");
        assertThat(found).hasSize(1);
        assertThat(found.get(0).call().url()).isEqualTo("https://a.com/x");
    }

    @Test
    void findAllByCycleIsScopedToThatCycleOnly() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.append("c1", call("https://a.com/x", "t1"));
        repo.append("c2", call("https://b.com/y", "t2"));

        assertThat(repo.findAllByCycle("c1")).extracting(c -> c.call().url()).containsExactly("https://a.com/x");
        assertThat(repo.findAllByCycle("c2")).extracting(c -> c.call().url()).containsExactly("https://b.com/y");
    }

    @Test
    void removeByIdRemovesOnlyTheMatchingCapturedCallInThatCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CapturedCall a = repo.append("c1", call("a", "t1"));
        CapturedCall b = repo.append("c1", call("b", "t2"));

        assertThat(repo.removeById("c1", a.id())).isTrue();

        assertThat(repo.findAllByCycle("c1")).extracting(CapturedCall::id).containsExactly(b.id());
        assertThat(repo.removeById("c1", "missing")).isFalse();
    }

    @Test
    void removeByIdsRemovesMultipleAndReturnsHowManyWereRemoved() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CapturedCall a = repo.append("c1", call("a", "t1"));
        CapturedCall b = repo.append("c1", call("b", "t2"));
        repo.append("c1", call("c", "t3"));

        int removed = repo.removeByIds("c1", List.of(a.id(), b.id(), "missing"));

        assertThat(removed).isEqualTo(2);
        assertThat(repo.findAllByCycle("c1")).extracting(c -> c.call().url()).containsExactly("c");
    }

    @Test
    void deleteAllForCycleRemovesEveryCapturedCallInThatCycleOnly() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.append("c1", call("a", "t1"));
        repo.append("c2", call("b", "t2"));

        repo.deleteAllForCycle("c1");

        assertThat(repo.findAllByCycle("c1")).isEmpty();
        assertThat(repo.findAllByCycle("c2")).hasSize(1);
    }

    @Test
    void findByCallIdLooksUpByTheUnderlyingCallRecordId() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord call = call("https://a.com/x", "t1");
        CapturedCall captured = repo.append("c1", call);

        assertThat(repo.findByCallId("c1", call.id())).isPresent();
        assertThat(repo.findByCallId("c1", captured.id())).isEmpty();
    }

    @Test
    void queryFiltersSortsAndPaginatesScopedToOneCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.append("c1", call("https://a.com/x", "t1"));
        repo.append("c1", call("https://b.com/y", "t2"));
        repo.append("c2", call("https://c.com/z", "t3"));

        var page = repo.query("c1", "", "", "oldest", 0, 10, true);

        assertThat(page.items()).extracting(c -> c.call().url()).containsExactly("https://a.com/x", "https://b.com/y");
        assertThat(page.total()).isEqualTo(2);
    }

    @Test
    void querySearchMatchesInsideBodies() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord withNeedle = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "GET",
                null, "t1", 1.0, new com.fathy.alfred.backend.calls.domain.model.ResponseData(200, null, "needle-here"), null);
        repo.append("c1", withNeedle);
        repo.append("c1", call("https://b.com/y", "t2"));

        var page = repo.query("c1", "needle-here", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(c -> c.call().id()).containsExactly(withNeedle.id());
    }

    @Test
    void dedicatedIdFiltersNarrowIndependentlyOfTheGeneralSearchBox() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord target = new CallRecord("target-id", "https://a.com/x", "https://a.com/x", "GET",
                null, "t", 1.0, new ResponseData(200, null, null), null, CallLifecycleStatus.COMPLETED, "session-abc", "operation-xyz");
        CallRecord other = new CallRecord("other-id", "https://b.com/y", "https://b.com/y", "GET",
                null, "t", 1.0, new ResponseData(200, null, null), null, CallLifecycleStatus.COMPLETED, "session-def", "operation-uvw");
        repo.append("c1", target);
        repo.append("c1", other);

        assertThat(repo.query("c1", "", "", "newest", 0, 10, true, "session-abc", "", "").items())
                .extracting(c -> c.call().id()).containsExactly("target-id");
        assertThat(repo.query("c1", "", "", "newest", 0, 10, true, "", "operation-xyz", "").items())
                .extracting(c -> c.call().id()).containsExactly("target-id");
        assertThat(repo.query("c1", "", "", "newest", 0, 10, true, "", "", "target-id").items())
                .extracting(c -> c.call().id()).containsExactly("target-id");
        assertThat(repo.query("c1", "", "", "newest", 0, 10, true, "session-abc", "operation-uvw", "").items())
                .isEmpty();
    }

    @Test
    void querySummariesCarryThePrecomputedSupplierNameWithoutFetchingTheRequestBody() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(null, "{\"supplier\":\"FlyNas\"}"),
                "t", 1.0, null, null);
        repo.append("c1", call);

        var page = repo.query("c1", "", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(c -> c.call().supplierName()).containsExactly("FlyNas");
    }

    @Test
    void aBodyWithNoSupplierFieldReadsBackAsNullNotAnEmptyString() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(null, "{\"no-supplier-here\":true}"),
                "t", 1.0, null, null);
        repo.append("c1", call);

        var page = repo.query("c1", "", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(c -> c.call().supplierName()).containsExactly((String) null);
    }

    private static CallRecord preparedCall(String id, String url) {
        return new CallRecord(id, url, url, "GET", new RequestData(null, "{\"supplier\":\"FlyNas\"}"), "t",
                null, null, null, CallLifecycleStatus.IN_PROGRESS);
    }

    @Test
    void appendingAPreparedCallPersistsItInProgressWithNoResponseYet() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord prepared = preparedCall(UUID.randomUUID().toString(), "https://a.com/x");

        repo.append("c1", prepared);

        CapturedCall found = repo.findAllByCycle("c1").get(0);
        assertThat(found.call().state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
        assertThat(found.call().response()).isNull();
        var summary = repo.query("c1", "", "", "newest", 0, 10, true).items().get(0);
        assertThat(summary.call().state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
        assertThat(summary.call().supplierName()).isEqualTo("FlyNas");
    }

    @Test
    void completingACapturedCallFillsInTheResponseAndFlipsStateToCompleted() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));

        boolean updated = repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "{\"ok\":true}"), null, 42.0, null, null);

        assertThat(updated).isTrue();
        CapturedCall found = repo.findAllByCycle("c1").get(0);
        assertThat(found.call().state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(found.call().response().status()).isEqualTo(200);
        assertThat(found.call().durationMs()).isEqualTo(42.0);
    }

    @Test
    void completingACapturedCallPersistsInterceptionSoAnEditedCallStaysMarkedEditedOnceCaptured() throws Exception {
        // interception used to be dropped entirely here: no column, INSERT/UPDATE never bound it,
        // and both row mappers built their CallRecord/CallSummary through the pre-interception
        // constructor - so GET /session-cycles/{id}/calls always answered null, even for a call the
        // live list showed as EDITED with its own "what changed" panel.
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));
        CallInterception interception = new CallInterception(
                List.of(new CallInterception.Applied("rule-1", "Slow Sabre", "SET_RESPONSE_STATUS", "500 -> 200")),
                null,
                new CallInterception.Http(500, "Internal Server Error", null, null, Map.of(), "{\"status\":\"FAILED\"}"),
                null,
                new CallInterception.Http(200, "OK", null, null, Map.of(), "{\"status\":\"CONFIRMED\"}"));

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "{\"status\":\"CONFIRMED\"}"), null, 42.0, null, interception);

        CapturedCall found = repo.findAllByCycle("c1").get(0);
        assertThat(found.call().interception()).isNotNull();
        assertThat(found.call().interception().applied()).hasSize(1);
        assertThat(found.call().interception().applied().get(0).ruleName()).isEqualTo("Slow Sabre");
        assertThat(found.call().interception().originalResponse().status()).isEqualTo(500);
        // The badge shows on a collapsed card too - it has to ride the SUMMARY, not just the detail.
        var summary = repo.query("c1", "", "", "newest", 0, 10, true).items().get(0);
        assertThat(summary.call().interception()).isNotNull();
        assertThat(summary.call().interception().applied()).hasSize(1);
    }

    @Test
    void aResentCallCapturedIntoARecordingCycleKeepsItsResendOfAndSummary() throws Exception {
        // A resend captured into a recording cycle showed no "resend of" and no Resent panel there,
        // while the same call on the live list showed both: neither field was ever stored.
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        Map<String, Object> edits = Map.of(
                "origin", Map.of("direction", "outbound", "cycleId", "cy-9"),
                "headers", List.of("X-Bulk-Test"),
                "batch", Map.of("id", "b1", "index", 2, "total", 3));
        CallRecord base = preparedCall(callId, "https://a.com/x");
        // state null on purpose - the append path normalizes it, which used to drop these fields too.
        CallRecord resent = new CallRecord(base.id(), base.originalUrl(), base.url(), base.method(), base.request(),
                base.timestamp(), null, null, null, null, null, null, null, null, null, "orig-1", edits);
        repo.append("c1", resent);
        repo.completeCapturedCall("c1", callId, new ResponseData(409, null, "{}"), null, 5.0, null, null);

        CapturedCall found = repo.findAllByCycle("c1").get(0);
        assertThat(found.call().resendOf()).isEqualTo("orig-1");
        assertThat(found.call().resendEdits()).isEqualTo(edits);
        var summary = repo.query("c1", "", "", "newest", 0, 10, true).items().get(0);
        assertThat(summary.call().resendOf()).isEqualTo("orig-1");
        assertThat(summary.call().resendEdits()).isEqualTo(edits);
    }

    @Test
    void aCapturedCallNoRuleTouchedCarriesNoInterceptionRecordAtAll() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "{}"), null, 1.0, null, null);

        assertThat(repo.findAllByCycle("c1").get(0).call().interception()).isNull();
        assertThat(repo.query("c1", "", "", "newest", 0, 10, true).items().get(0).call().interception()).isNull();
    }

    @Test
    void completingACapturedCallPersistsThePhaseTimingsMeasuredAtCompletion() throws Exception {
        // These were dropped entirely until now, which is why a cycle's diagnostics panel drew no
        // per-call phase bars while the identical panel on the live list did - same component, one
        // side simply had nothing to draw. They only exist at completion: the row was written while
        // the call was still in flight.
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "{}"), null, 196.62,
                new CallTiming(74.5, 57.03, 193.82, 2.77, false), null);

        CallTiming timing = repo.findAllByCycle("c1").get(0).call().timing();
        assertThat(timing).isNotNull();
        assertThat(timing.connectMs()).isEqualTo(74.5);
        assertThat(timing.tlsMs()).isEqualTo(57.03);
        assertThat(timing.ttfbMs()).isEqualTo(193.82);
        assertThat(timing.downloadMs()).isEqualTo(2.77);
        assertThat(timing.reusedConnection()).isFalse();
    }

    @Test
    void aCapturedCallWithNothingMeasuredReportsNoTimingAtAllRatherThanZeroes() throws Exception {
        // "Not measured" and "measured as instant" have to stay distinguishable - a call captured
        // before these columns existed must not read as a call that took no time to connect.
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "{}"), null, 10.0, null, null);

        assertThat(repo.findAllByCycle("c1").get(0).call().timing()).isNull();
    }

    @Test
    void completingACapturedCallWithAnErrorFlipsStateToError() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));

        repo.completeCapturedCall("c1", callId, null, "connection refused", null, null, null);

        CapturedCall found = repo.findAllByCycle("c1").get(0);
        assertThat(found.call().state()).isEqualTo(CallLifecycleStatus.ERROR);
        assertThat(found.call().error()).isEqualTo("connection refused");
    }

    @Test
    void searchFindsTextFromTheResponseOnlyAfterCompletingExtendsTheHaystack() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));

        assertThat(repo.query("c1", "needle-in-response", "", "newest", 0, 10, true).items()).isEmpty();

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "needle-in-response"), null, 1.0, null, null);

        var page = repo.query("c1", "needle-in-response", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(c -> c.call().id()).containsExactly(callId);
        assertThat(repo.query("c1", "supplier", "", "newest", 0, 10, true).items()).extracting(c -> c.call().id()).containsExactly(callId);
    }

    @Test
    void completingIsScopedToOneCycleAndDoesNotAffectTheSameCallCapturedInAnotherCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));
        repo.append("c2", preparedCall(callId, "https://a.com/x"));

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "ok"), null, 1.0, null, null);

        assertThat(repo.findAllByCycle("c1").get(0).call().state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(repo.findAllByCycle("c2").get(0).call().state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
    }

    @Test
    void completingAnUnknownCycleOrCallReturnsFalseWithoutThrowing() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));

        assertThat(repo.completeCapturedCall("missing-cycle", "missing-call", new ResponseData(200, null, null), null, 1.0, null, null)).isFalse();
    }

    @Test
    void migratesLegacySingleTableDataIntoTheThreeTableSchemaAndRenamesTheOldTable() throws Exception {
        Path dbFile = tempDir.resolve("session-cycles.db");
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE captured_calls (
                      id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, captured_at TEXT, call_id TEXT,
                      original_url TEXT, url TEXT, method TEXT, timestamp TEXT, timestamp_millis INTEGER,
                      duration_ms REAL, status INTEGER, status_rank INTEGER, supplier TEXT, supplier_name TEXT,
                      error TEXT, request_headers TEXT, request_body TEXT, response_headers TEXT,
                      response_body TEXT, haystack TEXT, status_state TEXT, request_haystack TEXT
                    )
                    """);
            statement.execute("""
                    INSERT INTO captured_calls (id, cycle_id, captured_at, call_id, original_url, url, method,
                                                 timestamp, status, supplier_name, request_headers, request_body,
                                                 response_headers, response_body, status_state)
                    VALUES ('captured-1', 'c1', 'ts', 'call-1', 'https://a.com/x', 'https://a.com/x', 'POST', 't', 200, 'FlyNas',
                            '{"Content-Type":"application/json"}', '{"supplier":"FlyNas"}', '{"X-Trace":"abc"}', '{"ok":true}', 'COMPLETED')
                    """);
        }

        SqliteSessionCyclesRepository repo = repositoryFor(dbFile);

        Optional<CapturedCall> found = repo.findByCallId("c1", "call-1");
        assertThat(found).isPresent();
        assertThat(found.get().id()).isEqualTo("captured-1");
        assertThat(found.get().call().request().headers()).containsEntry("Content-Type", "application/json");
        assertThat(found.get().call().response().body()).isEqualTo("{\"ok\":true}");
        var page = repo.query("c1", "", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(c -> c.call().supplierName()).containsExactly("FlyNas");

        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            var legacyTables = statement.executeQuery(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('captured_calls', 'captured_calls_legacy')");
            List<String> names = new ArrayList<>();
            while (legacyTables.next()) {
                names.add(legacyTables.getString("name"));
            }
            assertThat(names).containsExactly("captured_calls_legacy");
        }
    }

    @Test
    void migrationIsSkippedOnceCapturedCallMetadataAlreadyHasRows() throws Exception {
        Path dbFile = tempDir.resolve("session-cycles.db");
        SqliteSessionCyclesRepository firstInstance = repositoryFor(dbFile);
        firstInstance.append("c1", call("https://a.com/x", "t1"));
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE captured_calls (id TEXT PRIMARY KEY, cycle_id TEXT, call_id TEXT, url TEXT)");
            statement.execute("INSERT INTO captured_calls (id, cycle_id, call_id, url) VALUES ('should-not-be-migrated', 'c1', 'call-x', 'https://b.com/y')");
        }

        SqliteSessionCyclesRepository secondInstance = repositoryFor(dbFile);

        assertThat(secondInstance.findByCallId("c1", "call-x")).isEmpty();
        assertThat(secondInstance.capturedCallsCountAll()).isEqualTo(1);
    }

    @Test
    void removingACapturedCallCascadesToItsRequestAndResponseRows() throws Exception {
        Path dbFile = tempDir.resolve("session-cycles.db");
        SqliteSessionCyclesRepository repo = repositoryFor(dbFile);
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(java.util.Map.of("k", "v"), "body"), "t", 1.0, new ResponseData(200, null, "resp"), null);
        repo.append("c1", call);

        repo.deleteAllCapturedCalls();

        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            var requestCount = statement.executeQuery("SELECT COUNT(*) AS c FROM captured_call_request");
            requestCount.next();
            assertThat(requestCount.getInt("c")).isZero();
            var responseCount = statement.executeQuery("SELECT COUNT(*) AS c FROM captured_call_response");
            responseCount.next();
            assertThat(responseCount.getInt("c")).isZero();
        }
    }
    @Test
    void moveSpacerPersistsBothTheAnchorIdAndItsTimestamp() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CycleSpacer created = repo.createSpacer("c1", "Retry", null, null);

        repo.moveSpacer("c1", created.id(), "call-2", "2026-01-01T00:00:05Z");

        assertThat(repo.findAllSpacersByCycle("c1")).singleElement().satisfies(spacer -> {
            assertThat(spacer.afterCallId()).isEqualTo("call-2");
            assertThat(spacer.anchorTimestamp()).isEqualTo("2026-01-01T00:00:05Z");
        });
    }

    @Test
    void dropSpacerAnchorsToClearsTheAnchorIdButKeepsItsTimestampSoTheSpacerStaysInPlace() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.createSpacer("c1", "Retry", "call-1", "2026-01-01T00:00:01Z");

        repo.dropSpacerAnchorsTo("c1", List.of("call-1"));

        assertThat(repo.findAllSpacersByCycle("c1")).singleElement().satisfies(spacer -> {
            assertThat(spacer.afterCallId()).isNull();
            assertThat(spacer.anchorTimestamp()).isEqualTo("2026-01-01T00:00:01Z");
        });
    }

    @Test
    void aSpacersTableFromBeforeAfterAnchorsGetsItsNewColumnsAndItsRowsReadAsLegacyUntilMoved() throws Exception {
        Path dbFile = tempDir.resolve("session-cycles.db");
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + dbFile)) {
            connection.createStatement().execute("CREATE TABLE cycle_spacers (id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, label TEXT NOT NULL, before_call_id TEXT, created_at TEXT)");
            connection.createStatement().execute("INSERT INTO cycle_spacers VALUES ('s1', 'c1', 'Old', 'call-1', '2026-01-01T00:00:00Z')");
        }

        SqliteSessionCyclesRepository repo = repositoryFor(dbFile);

        assertThat(repo.findLegacySpacersByCycle("c1")).containsExactly(new LegacyCycleSpacer("s1", "call-1", null));
        assertThat(repo.findAllSpacersByCycle("c1")).containsExactly(new CycleSpacer("s1", "c1", "Old", null, "2026-01-01T00:00:00Z", null));

        repo.moveSpacer("c1", "s1", "call-0", "2026-01-01T00:00:00Z");

        assertThat(repo.findLegacySpacersByCycle("c1")).isEmpty();
        assertThat(repo.findAllSpacersByCycle("c1")).containsExactly(new CycleSpacer("s1", "c1", "Old", "call-0", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"));
    }

    @Test
    void aNewSpacerIsNeverLegacy() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));

        repo.createSpacer("c1", "Retry", null, null);

        assertThat(repo.findLegacySpacersByCycle("c1")).isEmpty();
    }

    @Test
    void dropSpacerAnchorsToAlsoClearsALegacySpacersAnchorSoItsConversionSeesTheCallAsGone() throws Exception {
        Path dbFile = tempDir.resolve("session-cycles.db");
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + dbFile)) {
            connection.createStatement().execute("CREATE TABLE cycle_spacers (id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, label TEXT NOT NULL, before_call_id TEXT, created_at TEXT, anchor_timestamp TEXT)");
            connection.createStatement().execute("INSERT INTO cycle_spacers VALUES ('s1', 'c1', 'Old', 'call-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')");
        }
        SqliteSessionCyclesRepository repo = repositoryFor(dbFile);

        repo.dropSpacerAnchorsTo("c1", List.of("call-1"));

        assertThat(repo.findLegacySpacersByCycle("c1")).containsExactly(new LegacyCycleSpacer("s1", null, "2026-01-01T00:00:01Z"));
    }
}
