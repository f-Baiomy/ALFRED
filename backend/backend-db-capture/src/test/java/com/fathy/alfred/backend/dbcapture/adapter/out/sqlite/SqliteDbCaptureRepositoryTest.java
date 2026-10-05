package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.Fixtures;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
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
}
