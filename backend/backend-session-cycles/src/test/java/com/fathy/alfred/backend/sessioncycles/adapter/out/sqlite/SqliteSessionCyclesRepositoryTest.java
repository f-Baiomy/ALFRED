package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
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

    @Test
    void aCapturedCallWithNoSupplierFieldIsNeverRescannedByTheBackfillOnANewRepositoryInstance() throws Exception {
        // See SqliteCallsRepositoryTest's identical regression test - "" (not SQL NULL) is what
        // marks a row as already processed with no supplier field found.
        Path dbFile = tempDir.resolve("session-cycles.db");
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(null, "{\"no-supplier-here\":true}"),
                "t", 1.0, null, null);
        repositoryFor(dbFile).append("c1", call);

        repositoryFor(dbFile);

        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement();
             var rs = statement.executeQuery("SELECT COUNT(*) AS c FROM captured_calls WHERE supplier_name IS NULL AND request_body IS NOT NULL")) {
            rs.next();
            assertThat(rs.getInt("c")).isZero();
        }
    }

    @Test
    void backfillsSupplierNameForCapturedCallsWrittenBeforeTheColumnWasPopulated() throws Exception {
        Path dbFile = tempDir.resolve("session-cycles.db");
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(null, "{\"supplier\":\"Galileo\"}"),
                "t", 1.0, null, null);
        SqliteSessionCyclesRepository firstInstance = repositoryFor(dbFile);
        firstInstance.append("c1", call);
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            statement.execute("UPDATE captured_calls SET supplier_name = NULL");
        }

        SqliteSessionCyclesRepository secondInstance = repositoryFor(dbFile);

        var page = secondInstance.query("c1", "", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(c -> c.call().supplierName()).containsExactly("Galileo");
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

        boolean updated = repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "{\"ok\":true}"), null, 42.0);

        assertThat(updated).isTrue();
        CapturedCall found = repo.findAllByCycle("c1").get(0);
        assertThat(found.call().state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(found.call().response().status()).isEqualTo(200);
        assertThat(found.call().durationMs()).isEqualTo(42.0);
    }

    @Test
    void completingACapturedCallWithAnErrorFlipsStateToError() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        String callId = UUID.randomUUID().toString();
        repo.append("c1", preparedCall(callId, "https://a.com/x"));

        repo.completeCapturedCall("c1", callId, null, "connection refused", null);

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

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "needle-in-response"), null, 1.0);

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

        repo.completeCapturedCall("c1", callId, new ResponseData(200, null, "ok"), null, 1.0);

        assertThat(repo.findAllByCycle("c1").get(0).call().state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(repo.findAllByCycle("c2").get(0).call().state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
    }

    @Test
    void completingAnUnknownCycleOrCallReturnsFalseWithoutThrowing() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));

        assertThat(repo.completeCapturedCall("missing-cycle", "missing-call", new ResponseData(200, null, null), null, 1.0)).isFalse();
    }
}
