package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteCallsRepositoryTest {

    @TempDir
    Path tempDir;

    private final List<SqliteCallsRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteCallsRepository::close);
        // Windows sometimes needs a moment after the last JDBC connection closes before it
        // actually releases the file handle - without this, @TempDir's own cleanup can
        // occasionally race that release and fail to delete the directory.
        Thread.sleep(50);
    }

    private SqliteCallsRepository repositoryFor(Path dbFile) throws Exception {
        return repositoryFor(dbFile, Long.MAX_VALUE);
    }

    private SqliteCallsRepository repositoryFor(Path dbFile, long maxSizeBytes) throws Exception {
        SqliteCallsRepository repository = new SqliteCallsRepository();
        setField(repository, "dbFile", dbFile.toString());
        setField(repository, "maxSizeBytes", maxSizeBytes);
        repository.init();
        opened.add(repository);
        return repository;
    }

    private static void setField(SqliteCallsRepository repository, String name, Object value) throws Exception {
        Field field = SqliteCallsRepository.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(repository, value);
    }

    private static CallRecord call(String url, String timestamp, Double durationMs, Integer status, String error) {
        return new CallRecord(UUID.randomUUID().toString(), url, url, "GET", new RequestData(null, null), timestamp,
                durationMs, status == null ? null : new ResponseData(status, null, null), error);
    }

    @Test
    void saveThenFindByIdRoundTrips() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord call = call("https://a.com/x", "t", 42.0, 200, null);

        repo.save(call);

        Optional<CallRecord> found = repo.findById(call.id());
        assertThat(found).isPresent();
        assertThat(found.get().url()).isEqualTo("https://a.com/x");
        assertThat(found.get().durationMs()).isEqualTo(42.0);
    }

    @Test
    void findByIdReturnsEmptyForAnUnknownId() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));

        assertThat(repo.findById("missing")).isEmpty();
    }

    @Test
    void preservesRequestAndResponseBodiesAndHeaders() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(java.util.Map.of("Content-Type", "application/json"), "{\"a\":1}"),
                "t", 1.0, new ResponseData(200, java.util.Map.of("X-Trace", "abc"), "{\"ok\":true}"), null);

        repo.save(call);

        CallRecord found = repo.findById(call.id()).orElseThrow();
        assertThat(found.request().headers()).containsEntry("Content-Type", "application/json");
        assertThat(found.request().body()).isEqualTo("{\"a\":1}");
        assertThat(found.response().headers()).containsEntry("X-Trace", "abc");
        assertThat(found.response().body()).isEqualTo("{\"ok\":true}");
    }

    @Test
    void oldestIsInsertionOrder() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("a", "t", 1.0, 200, null));
        repo.save(call("b", "t", 1.0, 200, null));

        var page = repo.query("", "", "oldest", 0, 10, true);

        assertThat(page.items()).extracting(CallSummary::url).containsExactly("a", "b");
    }

    @Test
    void newestReversesInsertionOrder() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("a", "t", 1.0, 200, null));
        repo.save(call("b", "t", 1.0, 200, null));

        var page = repo.query("", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallSummary::url).containsExactly("b", "a");
    }

    @Test
    void sortsByParsedCallTimestamp() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("late", "2026-01-02T00:00:00Z", 1.0, 200, null));
        repo.save(call("early", "2026-01-01T00:00:00Z", 1.0, 200, null));
        repo.save(call("unparseable", "not-a-date", 1.0, 200, null));

        var oldest = repo.query("", "", "oldest-call", 0, 10, true);
        assertThat(oldest.items()).extracting(CallSummary::url).containsExactly("unparseable", "early", "late");

        var newest = repo.query("", "", "newest-call", 0, 10, true);
        assertThat(newest.items()).extracting(CallSummary::url).containsExactly("late", "early", "unparseable");
    }

    @Test
    void sortsByDuration() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("slow", "t", 500.0, 200, null));
        repo.save(call("fast", "t", 10.0, 200, null));

        var slowest = repo.query("", "", "slowest", 0, 10, true);
        assertThat(slowest.items()).extracting(CallSummary::url).containsExactly("slow", "fast");

        var fastest = repo.query("", "", "fastest", 0, 10, true);
        assertThat(fastest.items()).extracting(CallSummary::url).containsExactly("fast", "slow");
    }

    @Test
    void sortsByStatusWithErrorsRankedWorst() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("ok", "t", 1.0, 200, null));
        repo.save(call("errored", "t", 1.0, null, "boom"));
        repo.save(call("serverError", "t", 1.0, 500, null));

        var page = repo.query("", "", "status", 0, 10, true);

        assertThat(page.items()).extracting(CallSummary::url).containsExactly("errored", "serverError", "ok");
    }

    @Test
    void searchMatchesUrlCaseInsensitively() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("https://Api.Example.com/x", "t", 1.0, 200, null));
        repo.save(call("https://other.com/y", "t", 1.0, 200, null));

        var page = repo.query("api.example", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallSummary::url).containsExactly("https://Api.Example.com/x");
    }

    @Test
    void searchMatchesInsideALargeResponseBody() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        // Needle placed well before MAX_HAYSTACK_LENGTH (20,000) - the body itself is still huge
        // (150KB, stored and returned in full via the response_body column) but the FTS index only
        // covers a bounded prefix, so search must still find text within that prefix.
        String bigBody = "x".repeat(5_000) + "needle-in-haystack" + "y".repeat(150_000);
        CallRecord withNeedle = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "GET",
                null, "t", 1.0, new ResponseData(200, null, bigBody), null);
        repo.save(withNeedle);
        repo.save(call("https://b.com/y", "t", 1.0, 200, null));

        var page = repo.query("needle-in-haystack", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallSummary::id).containsExactly(withNeedle.id());
        assertThat(repo.findById(withNeedle.id())).get().extracting(c -> c.response().body()).isEqualTo(bigBody);
    }

    @Test
    void searchDoesNotMatchTextBeyondTheHaystackTruncationCap() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        String bigBody = "x".repeat(30_000) + "needle-too-far-in";
        CallRecord withNeedle = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "GET",
                null, "t", 1.0, new ResponseData(200, null, bigBody), null);
        repo.save(withNeedle);

        var page = repo.query("needle-too-far-in", "", "newest", 0, 10, true);

        // Documents the deliberate trade-off: capping FTS indexing cost means a match past the
        // cap isn't found by search - the full body is still available via GET /calls/{id}/detail.
        assertThat(page.items()).isEmpty();
    }

    @Test
    void filtersBySupplierHostname() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("https://a.com/x", "t", 1.0, 200, null));
        repo.save(call("https://b.com/y", "t", 1.0, 200, null));

        var page = repo.query("", "a.com", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallSummary::url).containsExactly("https://a.com/x");
    }

    @Test
    void paginatesWithOffsetAndReportsTotalBeforePaging() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("a", "t", 1.0, 200, null));
        repo.save(call("b", "t", 1.0, 200, null));
        repo.save(call("c", "t", 1.0, 200, null));
        repo.save(call("d", "t", 1.0, 200, null));

        var page1 = repo.query("", "", "oldest", 0, 2, true);
        assertThat(page1.items()).extracting(CallSummary::url).containsExactly("a", "b");
        assertThat(page1.total()).isEqualTo(4);

        var page2 = repo.query("", "", "oldest", 2, 2, true);
        assertThat(page2.items()).extracting(CallSummary::url).containsExactly("c", "d");
    }

    @Test
    void disabledPaginationIgnoresOffsetAndReturnsEverythingUpToLimit() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("a", "t", 1.0, 200, null));
        repo.save(call("b", "t", 1.0, 200, null));
        repo.save(call("c", "t", 1.0, 200, null));
        repo.save(call("d", "t", 1.0, 200, null));

        var page = repo.query("", "", "oldest", 2, 200, false);

        assertThat(page.items()).extracting(CallSummary::url).containsExactly("a", "b", "c", "d");
        assertThat(page.total()).isEqualTo(4);
    }

    @Test
    void querySummariesCarryThePrecomputedSupplierNameWithoutFetchingTheRequestBody() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(null, "{\"supplier\":\"FlyNas\"}"), "t", 1.0, new ResponseData(200, null, null), null);

        repo.save(call);

        var page = repo.query("", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(CallSummary::supplierName).containsExactly("FlyNas");
    }

    @Test
    void sessionAndOperationIdRoundTripThroughSaveFindByIdAndQuery() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "GET",
                null, "t", 1.0, new ResponseData(200, null, null), null, CallLifecycleStatus.COMPLETED, "session-1", "operation-1");

        repo.save(call);

        CallRecord found = repo.findById(call.id()).orElseThrow();
        assertThat(found.sessionId()).isEqualTo("session-1");
        assertThat(found.operationId()).isEqualTo("operation-1");
        var page = repo.query("", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(CallSummary::sessionId, CallSummary::operationId)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("session-1", "operation-1"));
    }

    @Test
    void searchFindsACallByItsOwnIdSessionIdOrOperationId() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord call = new CallRecord("findable-call-id", "https://a.com/x", "https://a.com/x", "GET",
                null, "t", 1.0, new ResponseData(200, null, null), null, CallLifecycleStatus.COMPLETED, "findable-session-id", "findable-operation-id");
        repo.save(call);
        repo.save(call("https://b.com/y", "t", 1.0, 200, null));

        assertThat(repo.query("findable-call-id", "", "newest", 0, 10, true).items())
                .extracting(CallSummary::id).containsExactly("findable-call-id");
        assertThat(repo.query("findable-session-id", "", "newest", 0, 10, true).items())
                .extracting(CallSummary::id).containsExactly("findable-call-id");
        assertThat(repo.query("findable-operation-id", "", "newest", 0, 10, true).items())
                .extracting(CallSummary::id).containsExactly("findable-call-id");
    }

    @Test
    void dedicatedIdFiltersNarrowIndependentlyOfTheGeneralSearchBox() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord target = new CallRecord("target-id", "https://a.com/x", "https://a.com/x", "GET",
                null, "t", 1.0, new ResponseData(200, null, null), null, CallLifecycleStatus.COMPLETED, "session-abc", "operation-xyz");
        CallRecord other = new CallRecord("other-id", "https://b.com/y", "https://b.com/y", "GET",
                null, "t", 1.0, new ResponseData(200, null, null), null, CallLifecycleStatus.COMPLETED, "session-def", "operation-uvw");
        repo.save(target);
        repo.save(other);

        assertThat(repo.query("", "", "newest", 0, 10, true, "session-abc", "", "").items())
                .extracting(CallSummary::id).containsExactly("target-id");
        assertThat(repo.query("", "", "newest", 0, 10, true, "", "operation-xyz", "").items())
                .extracting(CallSummary::id).containsExactly("target-id");
        assertThat(repo.query("", "", "newest", 0, 10, true, "", "", "target-id").items())
                .extracting(CallSummary::id).containsExactly("target-id");
        // Combining more than one non-blank id filter ANDs them together.
        assertThat(repo.query("", "", "newest", 0, 10, true, "session-abc", "operation-xyz", "").items())
                .extracting(CallSummary::id).containsExactly("target-id");
        assertThat(repo.query("", "", "newest", 0, 10, true, "session-abc", "operation-uvw", "").items())
                .isEmpty();
    }

    @Test
    void aBodyWithNoSupplierFieldReadsBackAsNullNotAnEmptyString() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(null, "{\"no-supplier-here\":true}"), "t", 1.0, null, null);

        repo.save(call);

        var page = repo.query("", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(CallSummary::supplierName).containsExactly((String) null);
    }

    @Test
    void concurrentWritesFromManyThreadsAllSucceedWithoutBeingDropped() throws Exception {
        // Regression test for the real bug this fixes: without busy_timeout applied to every
        // pooled connection (not just one), a second thread writing while another holds the
        // SQLite write lock got SQLITE_BUSY immediately instead of waiting - the exception
        // propagated up through CallsService.receiveNewCall and the incoming call was silently
        // dropped. All of these concurrent saves must succeed.
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        int threadCount = 16;
        ExecutorService executor = Executors.newFixedThreadPool(threadCount);
        try {
            List<CallRecord> calls = IntStream.range(0, threadCount)
                    .mapToObj(i -> call("https://concurrent.example.com/api/" + i, "t" + i, 1.0, 200, null))
                    .toList();
            List<java.util.concurrent.Future<?>> futures = new ArrayList<>();
            for (CallRecord call : calls) {
                futures.add(executor.submit(() -> repo.save(call)));
            }
            for (var future : futures) {
                future.get(10, TimeUnit.SECONDS);
            }
        } finally {
            executor.shutdown();
        }

        assertThat(repo.readAll()).hasSize(threadCount);
    }

    @Test
    void retentionTrimsOldestRowsOnceTheFileExceedsTheSizeCap() throws Exception {
        Path dbFile = tempDir.resolve("calls.db");
        // A tiny cap forces retention to kick in almost immediately once real rows exist on disk.
        SqliteCallsRepository repo = repositoryFor(dbFile, 20_000);
        String bigBody = "x".repeat(30_000);
        for (int i = 0; i < 60; i++) {
            CallRecord call = new CallRecord(UUID.randomUUID().toString(), "u" + i, "u" + i, "GET", null,
                    "t" + i, 1.0, new ResponseData(200, null, bigBody), null);
            repo.save(call);
        }

        List<CallRecord> remaining = repo.readAll();
        assertThat(remaining).isNotEmpty();
        assertThat(remaining.size()).isLessThan(60);
        // The oldest calls are the ones dropped, not the newest.
        assertThat(remaining).extracting(CallRecord::url).doesNotContain("u0", "u1");
    }

    private static CallRecord preparedCall(String id, String url) {
        return new CallRecord(id, url, url, "GET", new RequestData(null, "{\"supplier\":\"FlyNas\"}"), "t",
                null, null, null, CallLifecycleStatus.IN_PROGRESS);
    }

    @Test
    void savingAPreparedCallPersistsItInProgressWithNoResponseYet() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord prepared = preparedCall(UUID.randomUUID().toString(), "https://a.com/x");

        repo.save(prepared);

        CallRecord found = repo.findById(prepared.id()).orElseThrow();
        assertThat(found.state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
        assertThat(found.response()).isNull();
        assertThat(found.error()).isNull();
        var summary = repo.query("", "", "newest", 0, 10, true).items().get(0);
        assertThat(summary.state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
        // Precomputed from the request body regardless of the call still being in progress.
        assertThat(summary.supplierName()).isEqualTo("FlyNas");
    }

    @Test
    void completingAPreparedCallFillsInTheResponseAndFlipsStateToCompleted() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        String id = UUID.randomUUID().toString();
        repo.save(preparedCall(id, "https://a.com/x"));

        boolean updated = repo.complete(id, new ResponseData(200, null, "{\"ok\":true}"), null, 42.0);

        assertThat(updated).isTrue();
        CallRecord found = repo.findById(id).orElseThrow();
        assertThat(found.state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(found.response().status()).isEqualTo(200);
        assertThat(found.response().body()).isEqualTo("{\"ok\":true}");
        assertThat(found.durationMs()).isEqualTo(42.0);
    }

    @Test
    void completingAPreparedCallWithAnErrorFlipsStateToError() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        String id = UUID.randomUUID().toString();
        repo.save(preparedCall(id, "https://a.com/x"));

        repo.complete(id, null, "connection refused", null);

        CallRecord found = repo.findById(id).orElseThrow();
        assertThat(found.state()).isEqualTo(CallLifecycleStatus.ERROR);
        assertThat(found.error()).isEqualTo("connection refused");
        assertThat(found.response()).isNull();
    }

    @Test
    void completingWithBothAResponseAndAnErrorStoresTheResponseButStillClassifiesAsError() throws Exception {
        // The proxy sends both when the supplier answered but the client that made the original
        // request had already disconnected before the reply could reach it - the response must
        // still be fully visible even though the call is (correctly) classified as an error, since
        // the client itself never received it.
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        String id = UUID.randomUUID().toString();
        repo.save(preparedCall(id, "https://a.com/x"));

        repo.complete(id, new ResponseData(200, null, "{\"booked\":true}"), "client disconnected", 3500.0);

        CallRecord found = repo.findById(id).orElseThrow();
        assertThat(found.state()).isEqualTo(CallLifecycleStatus.ERROR);
        assertThat(found.error()).isEqualTo("client disconnected");
        assertThat(found.response()).isNotNull();
        assertThat(found.response().status()).isEqualTo(200);
        assertThat(found.response().body()).isEqualTo("{\"booked\":true}");
        assertThat(found.durationMs()).isEqualTo(3500.0);
    }

    @Test
    void searchFindsTextFromTheResponseOnlyAfterCompleteExtendsTheHaystack() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        String id = UUID.randomUUID().toString();
        repo.save(preparedCall(id, "https://a.com/x"));

        assertThat(repo.query("needle-in-response", "", "newest", 0, 10, true).items()).isEmpty();

        repo.complete(id, new ResponseData(200, null, "needle-in-response"), null, 1.0);

        var page = repo.query("needle-in-response", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(CallSummary::id).containsExactly(id);
        // The request-side match must still work too - complete() must extend the haystack, not replace it.
        assertThat(repo.query("supplier", "", "newest", 0, 10, true).items()).extracting(CallSummary::id).containsExactly(id);
    }

    @Test
    void completingAnUnknownIdReturnsFalseWithoutThrowing() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));

        boolean updated = repo.complete("does-not-exist", new ResponseData(200, null, null), null, 1.0);

        assertThat(updated).isFalse();
    }

    @Test
    void completingTheSameCallTwiceOverwritesWithTheSecondOutcome() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        String id = UUID.randomUUID().toString();
        repo.save(preparedCall(id, "https://a.com/x"));

        repo.complete(id, new ResponseData(200, null, "first"), null, 10.0);
        boolean secondUpdated = repo.complete(id, new ResponseData(500, null, "second"), null, 20.0);

        assertThat(secondUpdated).isTrue();
        CallRecord found = repo.findById(id).orElseThrow();
        assertThat(found.response().status()).isEqualTo(500);
        assertThat(found.response().body()).isEqualTo("second");
        assertThat(found.durationMs()).isEqualTo(20.0);
    }

    @Test
    void statusBreakdownCountsInProgressCallsInTheirOwnBucketNotOkOrErrors() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("https://a.com/ok", "t", 1.0, 200, null));
        repo.save(preparedCall(UUID.randomUUID().toString(), "https://a.com/pending"));

        var breakdown = repo.statusBreakdown();

        assertThat(breakdown.total()).isEqualTo(2);
        assertThat(breakdown.ok()).isEqualTo(1);
        assertThat(breakdown.inProgress()).isEqualTo(1);
        assertThat(breakdown.clientError()).isZero();
        assertThat(breakdown.serverError()).isZero();
    }

    @Test
    void migratesAPreTwoPhaseLegacySingleTableDerivingStatusStateForEachRow() throws Exception {
        Path dbFile = tempDir.resolve("calls.db");
        // Simulate the oldest possible legacy shape: a single-table calls.db that predates even
        // status_state/request_haystack (mirrors what addLegacyLifecycleColumnsIfMissing finds on
        // an existing deployment's first startup after the 3-table split ships).
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE calls (
                      id TEXT PRIMARY KEY, original_url TEXT, url TEXT, method TEXT, timestamp TEXT,
                      timestamp_millis INTEGER, duration_ms REAL, status INTEGER, status_rank INTEGER,
                      supplier TEXT, supplier_name TEXT, error TEXT, request_headers TEXT, request_body TEXT,
                      response_headers TEXT, response_body TEXT, haystack TEXT
                    )
                    """);
            statement.execute("INSERT INTO calls (id, url, status, supplier_name) VALUES ('ok-1', 'https://a.com/x', 200, '')");
            statement.execute("INSERT INTO calls (id, url, error, supplier_name) VALUES ('err-1', 'https://a.com/y', 'boom', '')");
        }

        SqliteCallsRepository repo = repositoryFor(dbFile);

        CallRecord ok = repo.findById("ok-1").orElseThrow();
        assertThat(ok.state()).isEqualTo(CallLifecycleStatus.COMPLETED);
        assertThat(ok.response().status()).isEqualTo(200);
        CallRecord err = repo.findById("err-1").orElseThrow();
        assertThat(err.state()).isEqualTo(CallLifecycleStatus.ERROR);
        assertThat(err.error()).isEqualTo("boom");
    }

    @Test
    void migratesLegacySingleTableDataIntoTheThreeTableSchemaAndRenamesTheOldTable() throws Exception {
        Path dbFile = tempDir.resolve("calls.db");
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE calls (
                      id TEXT PRIMARY KEY, original_url TEXT, url TEXT, method TEXT, timestamp TEXT,
                      timestamp_millis INTEGER, duration_ms REAL, status INTEGER, status_rank INTEGER,
                      supplier TEXT, supplier_name TEXT, error TEXT, request_headers TEXT, request_body TEXT,
                      response_headers TEXT, response_body TEXT, haystack TEXT, status_state TEXT, request_haystack TEXT
                    )
                    """);
            statement.execute("""
                    INSERT INTO calls (id, original_url, url, method, timestamp, status, supplier_name,
                                        request_headers, request_body, response_headers, response_body, status_state)
                    VALUES ('legacy-1', 'https://a.com/x', 'https://a.com/x', 'POST', 't', 200, 'FlyNas',
                            '{"Content-Type":"application/json"}', '{"supplier":"FlyNas"}', '{"X-Trace":"abc"}', '{"ok":true}', 'COMPLETED')
                    """);
        }

        SqliteCallsRepository repo = repositoryFor(dbFile);

        CallRecord found = repo.findById("legacy-1").orElseThrow();
        assertThat(found.request().headers()).containsEntry("Content-Type", "application/json");
        assertThat(found.request().body()).isEqualTo("{\"supplier\":\"FlyNas\"}");
        assertThat(found.response().headers()).containsEntry("X-Trace", "abc");
        assertThat(found.response().body()).isEqualTo("{\"ok\":true}");
        var page = repo.query("", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(CallSummary::supplierName).containsExactly("FlyNas");

        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            var legacyTables = statement.executeQuery(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('calls', 'calls_legacy')");
            List<String> names = new ArrayList<>();
            while (legacyTables.next()) {
                names.add(legacyTables.getString("name"));
            }
            assertThat(names).containsExactly("calls_legacy");
        }
    }

    @Test
    void migrationIsSkippedOnceCallMetadataAlreadyHasRows() throws Exception {
        Path dbFile = tempDir.resolve("calls.db");
        SqliteCallsRepository firstInstance = repositoryFor(dbFile);
        firstInstance.save(call("https://a.com/x", "t", 1.0, 200, null));
        // A legacy `calls` table appearing after the 3-table schema already has data (e.g. a
        // manually-restored old backup file placed alongside calls.db) must never be migrated in
        // and clobber/duplicate what's already there.
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE calls (id TEXT PRIMARY KEY, url TEXT)");
            statement.execute("INSERT INTO calls (id, url) VALUES ('should-not-be-migrated', 'https://b.com/y')");
        }

        SqliteCallsRepository secondInstance = repositoryFor(dbFile);

        assertThat(secondInstance.findById("should-not-be-migrated")).isEmpty();
        assertThat(secondInstance.count()).isEqualTo(1);
    }

    @Test
    void deletingACallCascadesToItsRequestAndResponseRows() throws Exception {
        Path dbFile = tempDir.resolve("calls.db");
        SqliteCallsRepository repo = repositoryFor(dbFile);
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(java.util.Map.of("k", "v"), "body"), "t", 1.0, new ResponseData(200, null, "resp"), null);
        repo.save(call);

        repo.deleteAll();

        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            var requestCount = statement.executeQuery("SELECT COUNT(*) AS c FROM call_request");
            requestCount.next();
            assertThat(requestCount.getInt("c")).isZero();
            var responseCount = statement.executeQuery("SELECT COUNT(*) AS c FROM call_response");
            responseCount.next();
            assertThat(responseCount.getInt("c")).isZero();
        }
    }
}
