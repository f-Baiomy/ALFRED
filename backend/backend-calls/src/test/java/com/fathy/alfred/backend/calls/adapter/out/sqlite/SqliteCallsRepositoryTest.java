package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
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

        assertThat(page.items()).extracting(CallRecord::url).containsExactly("a", "b");
    }

    @Test
    void newestReversesInsertionOrder() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("a", "t", 1.0, 200, null));
        repo.save(call("b", "t", 1.0, 200, null));

        var page = repo.query("", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallRecord::url).containsExactly("b", "a");
    }

    @Test
    void sortsByParsedCallTimestamp() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("late", "2026-01-02T00:00:00Z", 1.0, 200, null));
        repo.save(call("early", "2026-01-01T00:00:00Z", 1.0, 200, null));
        repo.save(call("unparseable", "not-a-date", 1.0, 200, null));

        var oldest = repo.query("", "", "oldest-call", 0, 10, true);
        assertThat(oldest.items()).extracting(CallRecord::url).containsExactly("unparseable", "early", "late");

        var newest = repo.query("", "", "newest-call", 0, 10, true);
        assertThat(newest.items()).extracting(CallRecord::url).containsExactly("late", "early", "unparseable");
    }

    @Test
    void sortsByDuration() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("slow", "t", 500.0, 200, null));
        repo.save(call("fast", "t", 10.0, 200, null));

        var slowest = repo.query("", "", "slowest", 0, 10, true);
        assertThat(slowest.items()).extracting(CallRecord::url).containsExactly("slow", "fast");

        var fastest = repo.query("", "", "fastest", 0, 10, true);
        assertThat(fastest.items()).extracting(CallRecord::url).containsExactly("fast", "slow");
    }

    @Test
    void sortsByStatusWithErrorsRankedWorst() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("ok", "t", 1.0, 200, null));
        repo.save(call("errored", "t", 1.0, null, "boom"));
        repo.save(call("serverError", "t", 1.0, 500, null));

        var page = repo.query("", "", "status", 0, 10, true);

        assertThat(page.items()).extracting(CallRecord::url).containsExactly("errored", "serverError", "ok");
    }

    @Test
    void searchMatchesUrlCaseInsensitively() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("https://Api.Example.com/x", "t", 1.0, 200, null));
        repo.save(call("https://other.com/y", "t", 1.0, 200, null));

        var page = repo.query("api.example", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallRecord::url).containsExactly("https://Api.Example.com/x");
    }

    @Test
    void searchMatchesInsideALargeResponseBody() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        String bigBody = "x".repeat(50_000) + "needle-in-haystack" + "y".repeat(50_000);
        CallRecord withNeedle = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "GET",
                null, "t", 1.0, new ResponseData(200, null, bigBody), null);
        repo.save(withNeedle);
        repo.save(call("https://b.com/y", "t", 1.0, 200, null));

        var page = repo.query("needle-in-haystack", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallRecord::id).containsExactly(withNeedle.id());
    }

    @Test
    void filtersBySupplierHostname() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("https://a.com/x", "t", 1.0, 200, null));
        repo.save(call("https://b.com/y", "t", 1.0, 200, null));

        var page = repo.query("", "a.com", "newest", 0, 10, true);

        assertThat(page.items()).extracting(CallRecord::url).containsExactly("https://a.com/x");
    }

    @Test
    void paginatesWithOffsetAndReportsTotalBeforePaging() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("a", "t", 1.0, 200, null));
        repo.save(call("b", "t", 1.0, 200, null));
        repo.save(call("c", "t", 1.0, 200, null));
        repo.save(call("d", "t", 1.0, 200, null));

        var page1 = repo.query("", "", "oldest", 0, 2, true);
        assertThat(page1.items()).extracting(CallRecord::url).containsExactly("a", "b");
        assertThat(page1.total()).isEqualTo(4);

        var page2 = repo.query("", "", "oldest", 2, 2, true);
        assertThat(page2.items()).extracting(CallRecord::url).containsExactly("c", "d");
    }

    @Test
    void disabledPaginationIgnoresOffsetAndReturnsEverythingUpToLimit() throws Exception {
        SqliteCallsRepository repo = repositoryFor(tempDir.resolve("calls.db"));
        repo.save(call("a", "t", 1.0, 200, null));
        repo.save(call("b", "t", 1.0, 200, null));
        repo.save(call("c", "t", 1.0, 200, null));
        repo.save(call("d", "t", 1.0, 200, null));

        var page = repo.query("", "", "oldest", 2, 200, false);

        assertThat(page.items()).extracting(CallRecord::url).containsExactly("a", "b", "c", "d");
        assertThat(page.total()).isEqualTo(4);
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
