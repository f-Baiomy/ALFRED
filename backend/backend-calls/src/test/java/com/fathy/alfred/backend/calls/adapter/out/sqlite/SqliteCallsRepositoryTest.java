package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
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
    void aBodyWithNoSupplierFieldReadsBackAsNullNotAnEmptyString() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(null, "{\"no-supplier-here\":true}"), "t", 1.0, null, null);

        repo.save(call);

        var page = repo.query("", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(CallSummary::supplierName).containsExactly((String) null);
    }

    @Test
    void aRowWithNoSupplierFieldIsNeverRescannedByTheBackfillOnANewRepositoryInstance() throws Exception {
        // Regression test: bindCall must store "" (an internal sentinel meaning "processed, no
        // supplier field"), not SQL NULL, when the body has no supplier field - otherwise this row
        // would look identical to "never processed" and the backfill would keep re-selecting and
        // re-updating it (a no-op, but pointlessly, and on a real 400+ row database this alone
        // added well over a minute to every single restart).
        Path dbFile = tempDir.resolve("calls.db");
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(null, "{\"no-supplier-here\":true}"), "t", 1.0, null, null);
        repositoryFor(dbFile).save(call);

        // init() (called by repositoryFor) already runs the backfill on this new instance - if the
        // row above were left NULL, this second instance's own backfill would still see it as
        // pending. Check the on-disk state directly rather than re-invoking backfill again.
        repositoryFor(dbFile);

        assertThat(countPendingBackfill(dbFile)).isZero();
    }

    private static int countPendingBackfill(Path dbFile) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement();
             var rs = statement.executeQuery("SELECT COUNT(*) AS c FROM calls WHERE supplier_name IS NULL AND request_body IS NOT NULL")) {
            rs.next();
            return rs.getInt("c");
        }
    }

    @Test
    void backfillsSupplierNameForRowsWrittenBeforeTheColumnWasPopulated() throws Exception {
        Path dbFile = tempDir.resolve("calls.db");
        CallRecord call = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "POST",
                new RequestData(null, "{\"supplier\":\"Galileo\"}"), "t", 1.0, null, null);
        SqliteCallsRepository firstInstance = repositoryFor(dbFile);
        firstInstance.save(call);
        // Simulate a row written before supplier_name existed/was populated - clear it directly,
        // bypassing the normal insert path bindCall() already covers.
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dbFile);
             var statement = connection.createStatement()) {
            statement.execute("UPDATE calls SET supplier_name = NULL");
        }

        // A fresh instance's init() runs the backfill.
        SqliteCallsRepository secondInstance = repositoryFor(dbFile);

        var page = secondInstance.query("", "", "newest", 0, 10, true);
        assertThat(page.items()).extracting(CallSummary::supplierName).containsExactly("Galileo");
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
}
