package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.Fixtures;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.domain.model.CallOnThread;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.TxLifecycle;
import com.fathy.alfred.backend.dbcapture.domain.model.TableIndex;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOrigin;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementTransaction;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.fathy.alfred.backend.dbcapture.Fixtures.statement;
import static com.fathy.alfred.backend.dbcapture.Fixtures.txEnd;
import static com.fathy.alfred.backend.dbcapture.Fixtures.updated;
import static org.assertj.core.api.Assertions.assertThat;

class SqliteDbCaptureRepositoryTest {

    @TempDir
    Path tempDir;

    private SqliteDbCaptureRepository repo;

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteDbCaptureRepository(new ObjectMapper().findAndRegisterModules());
        Field field = SqliteDbCaptureRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, tempDir.resolve("db-capture.db").toString());
        repo.init();
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50); // Windows releases the file handle a moment after the pool closes
    }

    @Test
    void ingestIsIdempotentOnTheAgentStatementId() {
        IncomingStatement s = Fixtures.select("a:1", "call-1", 1, 3);
        assertThat(repo.saveStatements(List.of(s))).isEqualTo(1);
        assertThat(repo.saveStatements(List.of(s))).isZero();
        assertThat(repo.allStatements("call-1", 100)).hasSize(1);
        assertThat(repo.rowCount(repo.allStatements("call-1", 100).get(0).id(), "RESULT")).isEqualTo(3);
    }

    @Test
    void keepsTheOrmOriginOfAStatement() {
        IncomingStatement plain = Fixtures.select("a:1", "call-1", 1, 1);
        StatementOrigin origin = new StatementOrigin("a:q1", "HQL", "from Org o where o.id = :id", "Org.byId", "list",
                List.of(new StatementOrigin.Param(":id", "948")), null, 50, null, null, null, null, null, null);
        IncomingStatement hql = new IncomingStatement("a:2", "call-1", null, plain.thread(), 2, plain.kind(), plain.sql(), plain.fingerprint(),
                plain.table(), plain.params(), plain.outcome(), plain.rows(), 0, null, null, plain.startedAt(), 10, 20, null, null, null, null,
                null, origin, List.of("OrgService.get(OrgService.java:452)", "Agency.set(Agency.java:126)"));
        repo.saveStatements(List.of(plain, hql));
        List<CapturedStatement> stored = repo.allStatements("call-1", 10);
        assertThat(stored.get(0).origin()).isNull();
        assertThat(stored.get(1).origin()).isEqualTo(origin);
        assertThat(stored.get(0).callers()).isNull();
        assertThat(stored.get(1).callers()).containsExactly("OrgService.get(OrgService.java:452)", "Agency.set(Agency.java:126)");
    }

    @Test
    void aTransactionKeepsItsLifecycle_andAStatementItsTablesIndexes() {
        StatementOutcome firstRead = new StatementOutcome(OutcomeKind.UPDATED, null, null, null, null, 1L, null, null, null, null, null, null, null,
                null, null, null, 54_210L, null, null, null, null);
        StatementOutcome jtaCommit = new StatementOutcome(OutcomeKind.TX_END, null, null, null, null, null, null, null, null, null, null, null, null,
                null, "COMMITTED", 223_500L, null, "JTA", 902L, 56_003L, 120L);
        IncomingStatement insert = statement("a:1", "call-1", 1, StatementKind.INSERT, "INSERT INTO agency VALUES (?)", firstRead, null, "tx-1");
        IncomingStatement commit = statement("a:2", "call-1", 2, StatementKind.COMMIT, "COMMIT", jtaCommit, null, "tx-1");
        List<TableIndex> indexes = List.of(new TableIndex("PK_AGENCY", true, List.of("ID")), new TableIndex("IX_AGENCY_BRANCH", false, List.of("BRANCH_ID", "NAME")));
        IncomingStatement withIndexes = new IncomingStatement(insert.sid(), insert.callId(), null, insert.thread(), insert.seq(), insert.kind(), insert.sql(),
                insert.fingerprint(), insert.table(), insert.params(), insert.outcome(), null, 0, null, null, insert.startedAt(), 10, 10, "tx-1",
                insert.connectionId(), insert.codeLocation(), insert.dataSource(), null, null, null, indexes);
        repo.saveStatements(List.of(withIndexes, commit));
        repo.refreshTransactions("call-1");

        StatementTransaction tx = repo.transactions("call-1").get(0);
        assertThat(tx.outcome()).isEqualTo(StatementTransaction.COMMITTED);
        assertThat(tx.lifecycle()).isEqualTo(new TxLifecycle("JTA", 54_210L, 902L, 56_003L, 120L));
        assertThat(tx.lifecycle().overheadMicros()).isEqualTo(54_210 + 902 + 56_003 + 120);
        assertThat(repo.allStatements("call-1", 10).get(0).indexes()).isEqualTo(indexes);
    }

    @Test
    void rowsArePagedAndContinuationChunksAppend() {
        IncomingStatement first = Fixtures.select("a:1", "call-1", 1, 500);
        repo.saveStatements(List.of(first));
        IncomingStatement more = new IncomingStatement(first.sid(), first.callId(), null, first.thread(), first.seq(), first.kind(), first.sql(),
                first.fingerprint(), first.table(), first.params(), Fixtures.rows(first.outcome().columns(), 700),
                Fixtures.select("x", "call-1", 1, 200).rows(), 500, null, null, first.startedAt(), first.durationMicros(),
                first.offsetMicros(), null, first.connectionId(), first.codeLocation(), first.dataSource(), null, null, null);
        repo.saveStatements(List.of(more));

        long id = repo.allStatements("call-1", 10).get(0).id();
        assertThat(repo.rowCount(id, "RESULT")).isEqualTo(700);
        assertThat(repo.statement(id).orElseThrow().storedRows()).isEqualTo(700);
        assertThat(repo.statement(id).orElseThrow().outcome().rowsRead()).isEqualTo(700);
        List<List<TypedValue>> page = repo.rows(id, "RESULT", 498, 4);
        assertThat(page).extracting(r -> r.get(0).value()).containsExactly("498", "499", "0", "1");
        assertThat(repo.columns(id, "RESULT")).extracting(c -> c.name()).containsExactly("id", "name");
    }

    @Test
    void aRollbackMarksItsTransactionsStatementsUndoneAndCountsInTheSummary() {
        repo.saveStatements(List.of(
                statement("a:1", "call-1", 1, StatementKind.INSERT, "INSERT INTO loyalty_history (user_id) VALUES (?)", updated(1), null, "tx-9"),
                statement("a:2", "call-1", 2, StatementKind.DELETE, "DELETE FROM loyalty_pending WHERE user_id = ?", updated(2), null, "tx-9"),
                statement("a:3", "call-1", 3, StatementKind.INSERT, "INSERT INTO loyalty_points (user_id) VALUES (?)",
                        Fixtures.failed("23000", 1, "ORA-00001: unique constraint violated"), null, "tx-9"),
                statement("a:4", "call-1", 4, StatementKind.ROLLBACK, "ROLLBACK", txEnd("ROLLED_BACK", 16000), null, "tx-9"),
                statement("a:5", "call-1", 5, StatementKind.UPDATE, "UPDATE wallet SET balance = ? WHERE user_id = ?", updated(1), null, null)));
        repo.refreshTransactions("call-1");
        repo.refreshSummary("call-1");

        List<StatementTransaction> txs = repo.transactions("call-1");
        assertThat(txs).singleElement().satisfies(tx -> {
            assertThat(tx.outcome()).isEqualTo(StatementTransaction.ROLLED_BACK);
            assertThat(tx.firstSeq()).isEqualTo(1);
            assertThat(tx.lastSeq()).isEqualTo(4);
            assertThat(tx.heldMicros()).isEqualTo(16000);
            assertThat(tx.writeCount()).isEqualTo(3);
        });
        assertThat(repo.allStatements("call-1", 10)).extracting(CapturedStatement::seq, CapturedStatement::undone)
                .containsExactly(org.assertj.core.groups.Tuple.tuple(1, true), org.assertj.core.groups.Tuple.tuple(2, true),
                        org.assertj.core.groups.Tuple.tuple(3, true), org.assertj.core.groups.Tuple.tuple(4, false),
                        org.assertj.core.groups.Tuple.tuple(5, false));

        CallDbSummary summary = repo.summary("call-1").orElseThrow();
        assertThat(summary.statementCount()).isEqualTo(5);
        assertThat(summary.writeCount()).isEqualTo(4);
        assertThat(summary.deleteCount()).isEqualTo(1);
        assertThat(summary.failedCount()).isEqualTo(1);
        assertThat(summary.transactionCount()).isEqualTo(1);
        assertThat(summary.rolledBackCount()).isEqualTo(1);
        assertThat(summary.lastSeq()).isEqualTo(5);
    }

    @Test
    void aCallOpenMarkerAloneGivesAZeroSummaryAndNoMarkerGivesNone() {
        repo.saveMarkers(List.of(new CallMarker("call-quiet", 0, MarkerType.CALL_OPEN, "2026-10-04T18:00:00Z", null, null)));
        repo.refreshSummary("call-quiet");
        repo.refreshSummary("call-never-captured");

        Map<String, CallDbSummary> summaries = repo.summaries(List.of("call-quiet", "call-never-captured"));
        assertThat(summaries).containsOnlyKeys("call-quiet");
        assertThat(summaries.get("call-quiet").statementCount()).isZero();
    }

    @Test
    void markersComeBackInOrderAndAddToTheLastSeq() {
        repo.saveMarkers(List.of(
                new CallMarker("call-1", 0, MarkerType.CALL_OPEN, "t0", null, null),
                new CallMarker("call-1", 7, MarkerType.HTTP_OUT, "t1", "POST", "https://pay.supplier.com/v1/charge")));
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 3, 1)));
        repo.refreshSummary("call-1");

        assertThat(repo.markers("call-1")).extracting(CallMarker::seq).containsExactly(0, 7);
        assertThat(repo.summary("call-1").orElseThrow().lastSeq()).isEqualTo(7);
    }

    @Test
    void theRequestThreadComesFromCallOpen_elseTheFirstStatement_andCallsAreFoundByThreadAndTime() {
        repo.saveMarkers(List.of(
                new CallMarker("call-a", 0, MarkerType.CALL_OPEN, "2026-10-05T04:34:15.000Z", null, null, "default task-4"),
                new CallMarker("call-b", 0, MarkerType.CALL_OPEN, "2026-10-05T04:34:40.000Z", null, null, "default task-4"),
                new CallMarker("call-c", 0, MarkerType.CALL_OPEN, "2026-10-05T04:34:20.000Z", null, null, "default task-9"),
                new CallMarker("call-old", 0, MarkerType.CALL_OPEN, "2026-10-05T04:00:00.000Z", null, null)));
        repo.saveStatements(List.of(Fixtures.select("a:9", "call-old", 1, 5)));

        assertThat(repo.requestThread("call-a")).contains("default task-4");
        assertThat(repo.requestThread("call-old")).isPresent(); // the first statement's thread
        assertThat(repo.requestThread("call-none")).isEmpty();
        assertThat(repo.callsOnThread("default task-4", "2026-10-05T04:34:00Z", "2026-10-05T04:34:59Z"))
                .extracting(CallOnThread::callId).containsExactly("call-a", "call-b");
        assertThat(repo.markers("call-a").get(0).thread()).isEqualTo("default task-4");
    }

    @Test
    void caughtLogLinesAreStoredInCallOrderCountedAndDeletedWithTheirCall() {
        repo.saveMarkers(List.of(new CallMarker("call-l", 0, MarkerType.CALL_OPEN, "2026-10-06T10:00:00Z", null, null, "t-1", true),
                new CallMarker("call-n", 0, MarkerType.CALL_OPEN, "2026-10-06T10:00:00Z", null, null, "t-2")));
        repo.saveLogLines(List.of(
                new CaughtLogLine(0, "call-l", 5, "2026-10-06T10:00:00.500Z", "WARN", "a.B", "t-1", "slow", null, null, null, false, "odeysys"),
                new CaughtLogLine(0, "call-l", 2, "2026-10-06T10:00:00Z", "ERROR", "a.B", "t-1", "boom", "java.lang.IllegalStateException", "bad",
                        "java.lang.IllegalStateException: bad\n\tat a.B.c(B.java:1)", true, "odeysys"),
                new CaughtLogLine(0, null, 0, "2026-10-06T10:00:01Z", "INFO", "job", "sched-1", "job fired", null, null, null, false, "odeysys")));
        repo.addDroppedLogs(java.util.Map.of("call-l", 3L));

        assertThat(repo.catchesLogs("call-l")).isTrue();
        assertThat(repo.catchesLogs("call-n")).isFalse();
        List<CaughtLogLine> lines = repo.logLines("call-l", 0, 100);
        assertThat(lines).extracting(CaughtLogLine::message).containsExactly("boom", "slow");
        assertThat(lines.get(0).at()).isEqualTo("2026-10-06T10:00:00.000Z"); // fixed fraction - text order is time order
        assertThat(lines.get(0).exceptionType()).isEqualTo("java.lang.IllegalStateException");
        assertThat(lines.get(0).exceptionStack()).contains("B.java:1");
        assertThat(lines.get(0).cut()).isTrue();
        assertThat(repo.logLines("call-l", 2, 100)).extracting(CaughtLogLine::message).containsExactly("slow");
        assertThat(repo.logCounts(List.of("call-l", "call-n"))).containsOnlyKeys("call-l")
                .extractingByKey("call-l").isEqualTo(new CaughtLogCounts(2, 1, 1, 3, 1));
        assertThat(repo.outsideLogLines("odeysys", null, 0, 10)).extracting(CaughtLogLine::message).containsExactly("job fired");
        assertThat(repo.outsideLogLines("odeysys", "other", 0, 10)).isEmpty();

        repo.deleteForCalls(List.of("call-l"));
        assertThat(repo.logLines("call-l", 0, 100)).isEmpty();
        assertThat(repo.logCounts(List.of("call-l"))).isEmpty();
        assertThat(repo.outsideLogLines("odeysys", null, 0, 10)).hasSize(1); // outside lines have their own bound
    }

    @Test
    void outsideLinesKeepOnlyTheNewestUpToTheirBound() {
        List<CaughtLogLine> many = new java.util.ArrayList<>();
        for (int i = 0; i < SqliteDbCaptureRepository.MAX_OUTSIDE_LOG_LINES + 5; i++) {
            many.add(new CaughtLogLine(0, null, 0, "2026-10-06T10:00:00Z", "INFO", "job", "sched", "line " + i, null, null, null, false, "p"));
        }
        repo.saveLogLines(many);

        List<CaughtLogLine> kept = repo.outsideLogLines("p", null, 0, 1);
        assertThat(kept.get(0).message()).isEqualTo("line 5");
    }

    @Test
    void callsOnAThreadCompareAsTimesNotTextAndTheLatestOnesBeforeAnInstantComeFirst() {
        // Instant.toString() drops a zero fraction: as text "…:00Z" sorts AFTER "…:00.500Z"
        repo.saveMarkers(List.of(
                new CallMarker("whole", 0, MarkerType.CALL_OPEN, "2026-10-05T04:35:00Z", null, null, "t"),
                new CallMarker("half", 0, MarkerType.CALL_OPEN, "2026-10-05T04:35:00.500Z", null, null, "t"),
                new CallMarker("next", 0, MarkerType.CALL_OPEN, "2026-10-05T04:35:01Z", null, null, "t")));

        assertThat(repo.callsOnThread("t", "2026-10-05T04:35:00.100Z", "2026-10-05T04:35:00.900Z")).extracting(CallOnThread::callId)
                .containsExactly("half");
        assertThat(repo.callsOnThread("t", "2026-10-05T04:35:00Z", "2026-10-05T04:35:01Z")).extracting(CallOnThread::callId)
                .containsExactly("whole", "half", "next");
        assertThat(repo.callsBefore("t", "2026-10-05T04:35:01Z", 2)).extracting(CallOnThread::callId).containsExactly("half", "whole");
        assertThat(repo.callsBefore("t", "2026-10-05T04:35:00.200Z", 5)).extracting(CallOnThread::callId).containsExactly("whole");
    }

    @Test
    void deletingCallsRemovesEverythingOfThemAndKeepsOutsideStatements() {
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 1, 5), Fixtures.select("a:2", "call-2", 1, 5),
                Fixtures.select("a:3", null, 1, 2)));
        repo.refreshSummary("call-1");
        repo.refreshSummary("call-2");

        assertThat(repo.deleteForCalls(List.of("call-1"))).isEqualTo(1);
        assertThat(repo.allStatements("call-1", 10)).isEmpty();
        assertThat(repo.summary("call-1")).isEmpty();
        assertThat(repo.allStatements("call-2", 10)).hasSize(1);

        repo.deleteAllCallStatements();
        assertThat(repo.allStatements("call-2", 10)).isEmpty();
        assertThat(repo.outsideStatements(null, 0, 10)).hasSize(1);
    }

    @Test
    void oldestCallIdsSkipsRetainedCalls() {
        for (int i = 1; i <= 4; i++) {
            repo.saveStatements(List.of(Fixtures.select("a:" + i, "call-" + i, 1, 1)));
            repo.refreshSummary("call-" + i);
        }
        assertThat(repo.oldestCallIds(2, Set.of("call-1"))).containsExactly("call-2", "call-3");
        assertThat(repo.totalBytes()).isPositive();
    }

    @Test
    void settingsDefaultUntilSavedAndAgentsRoundTrip() {
        assertThat(repo.settings("wallet-app").rowsPerResult()).isEqualTo(DbCaptureSettings.DEFAULT_ROWS_PER_RESULT);
        DbCaptureSettings custom = new DbCaptureSettings(100, List.of("payment_holds"), false, DbCaptureSettings.defaults().thresholds(), List.of(), List.of());
        repo.saveSettings("wallet-app", custom);
        assertThat(repo.settings("wallet-app")).isEqualTo(custom);

        repo.saveAgent(new AgentStatus("agent-1", "wallet-app", "1.0.0", "OpenJDK 1.8", "WildFly 26", 0, 0, "2026-10-04T18:00:00Z"));
        assertThat(repo.agents()).extracting(AgentStatus::agentId).containsExactly("agent-1");
    }

    // ------------------------------------------------------------------ failed statements (triage)

    private List<IncomingStatement> twoCallsOneFailing() {
        return List.of(
                Fixtures.select("a:1", "call-1", 1, 2),
                statement("a:2", "call-1", 2, StatementKind.INSERT, "INSERT INTO loyalty_points (user_id) VALUES (?)",
                        Fixtures.failed("23000", 1, "ORA-00001: unique constraint violated"), null, null),
                statement("a:3", "call-1", 3, StatementKind.CALL, "CALL LOG_HIT(?)", Fixtures.failed("42000", 1305, "PROCEDURE does not exist"), null, null),
                Fixtures.select("a:4", "call-2", 1, 2));
    }

    @Test
    void aFailedStatementIsMarkedAtInsert_andReadBackFromTheFailedIndexOnly() {
        repo.saveStatements(twoCallsOneFailing());
        repo.refreshSummary("call-1");
        repo.refreshSummary("call-2");

        Map<String, List<CapturedStatement>> failed = repo.failedStatements(List.of("call-1", "call-2", "call-x"), 50);
        assertThat(failed).containsOnlyKeys("call-1");
        assertThat(failed.get("call-1")).extracting(CapturedStatement::seq).containsExactly(2, 3);
        assertThat(repo.failedStatements(List.of("call-1"), 1).get("call-1")).extracting(CapturedStatement::seq).containsExactly(2);
        assertThat(repo.summary("call-1").orElseThrow().failedCount()).isEqualTo(2);
        assertThat(repo.summary("call-2").orElseThrow().failedCount()).isZero();

        assertThat(repo.failureCounts("call-1")).isEqualTo(new com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts(2, 0));
        repo.markFailuresSwallowed("call-1", true);
        assertThat(repo.failureCounts("call-1")).isEqualTo(new com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts(2, 2));
        assertThat(repo.failureCounts("call-2")).isEqualTo(com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts.NONE);
    }

    @Test
    void theFailedReadsUseThePartialIndex() throws Exception {
        repo.saveStatements(twoCallsOneFailing());
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + tempDir.resolve("db-capture.db"));
             var st = connection.createStatement()) {
            StringBuilder plan = new StringBuilder();
            try (var rs = st.executeQuery("EXPLAIN QUERY PLAN SELECT id FROM statements WHERE failed = 1 AND call_id IN ('call-1','call-2') ORDER BY call_id, seq")) {
                while (rs.next()) {
                    plan.append(rs.getString("detail")).append('\n');
                }
            }
            assertThat(plan.toString()).contains("ix_statements_failed");
        }
    }

    @Test
    void anExistingDatabaseGetsItsFailedStatementsMarkedOnceWhenTheColumnIsAdded() throws Exception {
        repo.saveStatements(twoCallsOneFailing());
        repo.close();
        Thread.sleep(50);
        // Turn the file back into what an older version left: no failed column, no index.
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + tempDir.resolve("db-capture.db"));
             var st = connection.createStatement()) {
            st.execute("DROP INDEX ix_statements_failed");
            st.execute("ALTER TABLE statements DROP COLUMN failed");
        }
        open();

        assertThat(repo.failedStatements(List.of("call-1", "call-2"), 50)).containsOnlyKeys("call-1");
        assertThat(repo.failureCounts("call-1").failed()).isEqualTo(2);
    }
}
