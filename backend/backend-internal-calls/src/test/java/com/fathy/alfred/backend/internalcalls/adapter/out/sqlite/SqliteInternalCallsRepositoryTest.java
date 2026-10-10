package com.fathy.alfred.backend.internalcalls.adapter.out.sqlite;

import com.fathy.alfred.backend.internalcalls.adapter.out.InternalCallStoreContractTest;
import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The store contract against the SQLite store (the default), plus what only a database store does. */
class SqliteInternalCallsRepositoryTest extends InternalCallStoreContractTest {

    @Override
    protected CallLogPort openStore(Path dir, int retentionRows, int wsMaxMessages) throws Exception {
        return adapterOver(repository(dir, retentionRows, wsMaxMessages, Long.MAX_VALUE), dir);
    }

    @Override
    protected void closeStore(CallLogPort store) {
        ((SqliteInternalCallLogAdapter) store).repository().close();
    }

    static SqliteInternalCallsRepository repository(Path dir, int retentionRows, int wsMaxMessages, long maxSizeBytes) throws Exception {
        return repository(new SqliteInternalCallsRepository(), dir, retentionRows, wsMaxMessages, maxSizeBytes);
    }

    static SqliteInternalCallsRepository repository(SqliteInternalCallsRepository repository, Path dir, int retentionRows,
                                                    int wsMaxMessages, long maxSizeBytes) throws Exception {
        set(repository, "dbFile", dir.resolve("internal-calls.db").toString());
        set(repository, "retentionRows", retentionRows);
        set(repository, "wsMaxMessages", wsMaxMessages);
        set(repository, "maxSizeBytes", maxSizeBytes);
        repository.init();
        return repository;
    }

    static SqliteInternalCallLogAdapter adapterOver(SqliteInternalCallsRepository repository, Path dir) throws Exception {
        SqliteInternalCallLogAdapter adapter = new SqliteInternalCallLogAdapter(repository);
        Field legacy = SqliteInternalCallLogAdapter.class.getDeclaredField("legacyFile");
        legacy.setAccessible(true);
        legacy.set(adapter, dir.resolve("internal-calls.log").toString());
        adapter.migrateLegacyFileIfPresent();
        return adapter;
    }

    private static void set(SqliteInternalCallsRepository repository, String name, Object value) throws Exception {
        Field field = SqliteInternalCallsRepository.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(repository, value);
    }

    @Test
    void prepareThenCompleteAndCompleteThenPrepareGiveTheSameCall() throws Exception {
        CallLogPort store = store(50);
        CallRecord request = prepared("p1", at(1));
        store.prepare(request);
        store.complete("p1", ok("same"), null, 7.0);

        store.complete("p2", ok("same"), null, 7.0, null, null,
                new CallRecord("p2", request.originalUrl(), request.url(), request.method(), null, at(1), null, null, null, null));
        store.prepareOrMerge(new CallRecord("p2", request.originalUrl(), request.url(), request.method(), request.request(), at(1),
                null, null, null, CallLifecycleStatus.IN_PROGRESS, request.sessionId(), request.operationId(), request.serviceName(),
                null, null, null, null, null));

        CallRecord a = store.findById("p1").orElseThrow();
        CallRecord b = store.findById("p2").orElseThrow();
        assertThat(b.request()).isEqualTo(a.request());
        assertThat(b.response()).isEqualTo(a.response());
        assertThat(List.of(b.url(), b.method(), b.timestamp(), b.serviceName(), b.state(), b.durationMs()))
                .isEqualTo(List.of(a.url(), a.method(), a.timestamp(), a.serviceName(), a.state(), a.durationMs()));
    }

    @Test
    void aPreparedCallSurvivesARestartInProgressAndCompletesAfterIt() throws Exception {
        SqliteInternalCallsRepository first = repository(dir, 50, 1000, Long.MAX_VALUE);
        first.prepare(prepared("open", at(1)));
        first.close();

        SqliteInternalCallLogAdapter second = adapterOver(repository(dir, 50, 1000, Long.MAX_VALUE), dir);
        try {
            assertThat(second.findById("open").orElseThrow().state()).isEqualTo(CallLogPortStates.IN_PROGRESS);
            assertThat(second.complete("open", ok("after restart"), null, 3.0)).isTrue();
            assertThat(second.findById("open").orElseThrow().request()).isNotNull();
        } finally {
            second.repository().close();
        }
    }

    @Test
    void retentionTrimsInSmallPassesNeverAllAtOnce() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 100_000, 1000, Long.MAX_VALUE);
        try {
            for (int i = 0; i < 500; i++) {
                repo.prepare(prepared("c" + i, at(i)));
                repo.complete("c" + i, ok("x"), null, 1.0, null, null, null);
            }
            repo.setRetentionRows(10);

            int deleted = repo.trimOnce();

            assertThat(deleted).isBetween(1, SqliteInternalCallsRepository.MAX_TRIM_BATCH);
            assertThat(repo.count()).isEqualTo(500 - deleted);
            while (repo.trimOnce() > 0) {
                // the remaining passes
            }
            assertThat(repo.count()).isEqualTo(10);
            assertThat(repo.findById("c499")).isPresent();
            assertThat(repo.findById("c489")).isEmpty();
        } finally {
            repo.close();
        }
    }

    @Test
    void retentionBySizeRemovesTheOldestCalls() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 100_000, 1000, 2_000_000);
        try {
            String body = "z".repeat(60_000);
            for (int i = 0; i < 120; i++) {
                repo.prepare(prepared("s" + i, at(i)));
                repo.complete("s" + i, ok(body), null, 1.0, null, null, null);
            }
            while (repo.trimOnce() > 0) {
                // until under the size cap
            }
            assertThat(repo.usedBytes()).isLessThanOrEqualTo(2_000_000L + 1_000_000L);
            assertThat(repo.findById("s119")).isPresent();
            assertThat(repo.findById("s0")).isEmpty();
        } finally {
            repo.close();
        }
    }

    @Test
    void trigramIndexAndPlainScanFindTheSameCalls() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 100, 1000, Long.MAX_VALUE);
        try {
            for (int i = 0; i < 20; i++) {
                repo.prepare(prepared("f" + i, at(i)));
                repo.complete("f" + i, ok(i % 3 == 0 ? "{\"code\":\"NeedleX\"}" : "{}"), null, 1.0, null, null, null);
            }
            List<String> indexed = ids(repo, "needlex");
            set(repo, "ftsAvailable", false);
            List<String> scanned = ids(repo, "needlex");
            assertThat(indexed).hasSize(7).isEqualTo(scanned);
        } finally {
            repo.close();
        }
    }

    @Test
    void readAllIsNeverUsedOnARequestPath() throws Exception {
        // The readAll()-over-SQLite trap (docs/architecture.md): every port default that filters readAll() reads every
        // body ever stored. Each one the services use is overridden with SQL - this fails if any falls back.
        SqliteInternalCallsRepository trap = repository(new SqliteInternalCallsRepository() {
            @Override
            public List<CallRecord> readAll() {
                throw new AssertionError("readAll() on a request path");
            }
        }, dir, 50, 1000, Long.MAX_VALUE);
        SqliteInternalCallLogAdapter store = adapterOver(trap, dir);
        try {
            call(store, "a", 1, 200, 1.0, "x");
            store.query("x", "", "slowest", 0, 10, true, "", "", "", "");
            store.query("", "", "newest", 0, 10, true, "", "", "", "", "exclude");
            store.findById("a");
            store.findByReliveRunId("run");
            store.findResolvedInRange(Instant.parse(at(0)), Instant.parse(at(9)), "", "", "", "", "");
            store.recentRequestHeaders("wildfly", 10);
            store.baselineFor("http://wildfly:8080/app/a");
            store.statusBreakdown();
            store.wsMessages("a", 0, 10);
            store.storageSizeBytes();
        } finally {
            trap.close();
        }
    }

    @Test
    void aFailedWriteIsReportedNotSwallowedAndReadsKeepWorking() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 50, 1000, Long.MAX_VALUE);
        try {
            repo.prepare(prepared("before", at(1)));
            repo.complete("before", ok("kept"), null, 1.0, null, null, null);
            try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("internal-calls.db"));
                 Statement s = c.createStatement()) {
                // Stands in for a full disk: every new call's insert now fails inside the database.
                s.execute("CREATE TRIGGER refuse BEFORE INSERT ON internal_call_metadata BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
            }

            assertThatThrownBy(() -> repo.prepare(prepared("after", at(2)))).isInstanceOf(IllegalStateException.class);

            assertThat(repo.findById("before").orElseThrow().response().body()).isEqualTo("kept");
            assertThat(repo.query("", "", "newest", 0, 10, true, "", "", "", "", "").total()).isEqualTo(1);
        } finally {
            repo.close();
        }
    }

    private static List<String> ids(SqliteInternalCallsRepository repo, String search) {
        return repo.query(search, "", "oldest", 0, 100, true, "", "", "", "", "").items().stream().map(CallSummary::id).toList();
    }

    // ------------------------------------------------------------------ deletion cascade

    /** Collects what the store reports deleted - stands in for backend-app's cascade. */
    private static final class Removed implements com.fathy.alfred.backend.internalcalls.application.port.out.InternalCallsRemovedPort {
        final java.util.List<String> ids = new java.util.ArrayList<>();

        @Override
        public void callsRemoved(java.util.Collection<String> callIds) {
            ids.addAll(callIds);
        }
    }

    @Test
    void theRetentionLimitReportsExactlyTheCallsItDeleted() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 3, 1000, Long.MAX_VALUE);
        Removed removed = new Removed();
        repo.setRemovedListeners(java.util.List.of(removed));
        try {
            for (int i = 0; i < 5; i++) {
                repo.prepare(prepared("c" + i, at(i)));
                repo.complete("c" + i, ok("x"), null, 1.0, null, null, null);
            }
            assertThat(repo.count()).isEqualTo(3);
            assertThat(removed.ids).containsExactlyInAnyOrder("c0", "c1");
        } finally {
            repo.close();
        }
    }

    @Test
    void clearingAndDeletingByIdReportEveryDeletedCall() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 100, 1000, Long.MAX_VALUE);
        Removed removed = new Removed();
        repo.setRemovedListeners(java.util.List.of(removed));
        try {
            for (int i = 0; i < 4; i++) {
                repo.prepare(prepared("c" + i, at(i)));
            }
            assertThat(repo.deleteByIds(java.util.List.of("c1", "c2", "missing"))).isEqualTo(2);
            assertThat(removed.ids).containsExactlyInAnyOrder("c1", "c2", "missing");
            assertThat(repo.findById("c1")).isEmpty();
            assertThat(repo.findById("c0")).isPresent();

            removed.ids.clear();
            repo.deleteAll();
            assertThat(removed.ids).containsExactlyInAnyOrder("c0", "c3");
        } finally {
            repo.close();
        }
    }

    @Test
    void aLoweredSizeLimitTrimsAtOnce() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 100_000, 1000, Long.MAX_VALUE);
        Removed removed = new Removed();
        repo.setRemovedListeners(java.util.List.of(removed));
        try {
            for (int i = 0; i < 40; i++) {
                repo.prepare(prepared("c" + i, at(i)));
                repo.complete("c" + i, ok("x".repeat(20_000)), null, 1.0, null, null, null);
            }
            long before = repo.storageSizeBytes();
            repo.setMaxSizeBytes(before / 2);

            // trimmed before the next call arrives, oldest first
            assertThat(repo.count()).isLessThan(40);
            assertThat(removed.ids).isNotEmpty().contains("c0").doesNotContain("c39");
        } finally {
            repo.close();
        }
    }

    @Test
    void cleanupCandidatesFilterByAgeStatusAndUrlOldestFirstAndNeverInFlight() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 100, 1000, Long.MAX_VALUE);
        try {
            repo.prepare(prepared("old-ok", at(1)));
            repo.complete("old-ok", ok("x"), null, 1.0, null, null, null);
            repo.prepare(prepared("old-fail", at(2)));
            repo.complete("old-fail", new ResponseData(500, null, "boom"), null, 1.0, null, null, null);
            repo.prepare(prepared("still-open", at(3)));
            repo.prepare(prepared("new-ok", at(50)));
            repo.complete("new-ok", ok("x"), null, 1.0, null, null, null);
            String before = java.time.Instant.parse(at(10)).toString();

            var all = repo.cleanupCandidates(new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(before, null, null, null), 100);
            var failed = repo.cleanupCandidates(new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(null, "odeysys", "5xx", null), 100);
            var byUrl = repo.cleanupCandidates(new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(null, null, null, "NEW-OK"), 100);

            assertThat(all).extracting(c -> c.id()).containsExactly("old-ok", "old-fail");
            assertThat(all.get(0).bytes()).isPositive();
            assertThat(failed).extracting(c -> c.id()).containsExactly("old-fail");
            assertThat(byUrl).extracting(c -> c.id()).containsExactly("new-ok");
            assertThat(repo.oldestTimestamp()).contains(at(1));
        } finally {
            repo.close();
        }
    }

    /** Readability alias for the lifecycle state the assertions name. */
    private static final class CallLogPortStates {
        static final CallLifecycleStatus IN_PROGRESS = CallLifecycleStatus.IN_PROGRESS;
    }

    @Test
    void theLimitsSkipAKeptCallAndTrimTheNextOldest() throws Exception {
        SqliteInternalCallsRepository repo = repository(dir, 2, 1000, Long.MAX_VALUE);
        repo.setKept(() -> java.util.Set.of("c0"));
        try {
            for (int i = 0; i < 4; i++) {
                repo.prepare(prepared("c" + i, at(i)));
            }
            assertThat(repo.findById("c0")).isPresent();
            assertThat(repo.findById("c1")).isEmpty();
            assertThat(repo.findById("c3")).isPresent();
        } finally {
            repo.close();
        }
    }
}
