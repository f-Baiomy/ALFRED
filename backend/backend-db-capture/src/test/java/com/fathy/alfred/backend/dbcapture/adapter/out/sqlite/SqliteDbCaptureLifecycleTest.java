package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.Fixtures;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureQueryService;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureRetention;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureService;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.RowsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static com.fathy.alfred.backend.dbcapture.Fixtures.failed;
import static com.fathy.alfred.backend.dbcapture.Fixtures.statement;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/** Query, completion, retention and run deletion against a real db-capture.db. */
class SqliteDbCaptureLifecycleTest {

    @TempDir
    Path tempDir;

    private SqliteDbCaptureRepository repo;
    private DbCaptureService service;
    private DbCaptureQueryService query;

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteDbCaptureRepository(new ObjectMapper().findAndRegisterModules());
        Field field = SqliteDbCaptureRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, tempDir.resolve("db-capture.db").toString());
        repo.init();
        service = new DbCaptureService(repo, mock(DbCaptureNotificationPort.class), mock(DbCaptureTogglePort.class),
                List.of(new com.fathy.alfred.backend.dbcapture.application.service.DbCaptureFlagsListener(repo)), Optional.empty());
        query = new DbCaptureQueryService(repo, service);
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50);
    }

    private void ingest(List<IncomingStatement> statements, List<CallMarker> markers) {
        service.ingest(new IngestBatch("agent-1", "wallet-app", statements, markers, Map.of()));
    }

    @Test
    void statementsArePagedBySequenceWithSupplierMarkersAlongside() {
        ingest(List.of(Fixtures.select("a:1", "c1", 1, 2), Fixtures.select("a:2", "c1", 2, 0), Fixtures.select("a:4", "c1", 4, 0)),
                List.of(new CallMarker("c1", 0, MarkerType.CALL_OPEN, "2026-10-04T18:00:00Z", null, null),
                        new CallMarker("c1", 3, MarkerType.HTTP_OUT, "2026-10-04T18:00:01Z", "POST", "https://pay.example/charge")));

        CallStatementsPage first = query.statements("c1", 0, 2);
        assertThat(first.statements()).extracting(s -> s.seq()).containsExactly(1, 2);
        assertThat(first.hasMore()).isTrue();
        assertThat(first.supplierMarkers()).singleElement().satisfies(m -> assertThat(m.seq()).isEqualTo(3));
        CallStatementsPage rest = query.statements("c1", 2, 2);
        assertThat(rest.statements()).extracting(s -> s.seq()).containsExactly(4);
        assertThat(rest.hasMore()).isFalse();

        long id = first.statements().get(0).id();
        RowsPage rows = query.rows(id, "RESULT", 1, 10).orElseThrow();
        assertThat(rows.total()).isEqualTo(2);
        assertThat(rows.rows()).hasSize(1);
        assertThat(rows.columns()).extracting(c -> c.name()).containsExactly("id", "name");
        assertThat(query.rows(999_999, "RESULT", 0, 10)).isEmpty();
        assertThat(query.summaries(List.of("c1", "unknown"))).containsOnlyKeys("c1");
    }

    @Test
    void aFailureTheCallAnsweredSuccessfullyOverIsSwallowed() {
        ingest(List.of(statement("a:1", "c1", 1, StatementKind.INSERT, "INSERT INTO audit VALUES (?)", failed("23505", 1, "duplicate"), null, null)),
                List.of());
        service.callCompleted("c1", 200, null);
        assertThat(repo.allStatements("c1", 10).get(0).outcome().swallowed()).isTrue();
        assertThat(repo.summary("c1").orElseThrow().complete()).isTrue();
        assertThat(repo.summary("c1").orElseThrow().endedEarly()).isFalse();

        ingest(List.of(statement("a:2", "c2", 1, StatementKind.INSERT, "INSERT INTO audit VALUES (?)", failed("23505", 1, "duplicate"), null, null)),
                List.of());
        service.callCompleted("c2", 500, null);
        assertThat(repo.allStatements("c2", 10).get(0).outcome().swallowed()).isFalse();
    }

    @Test
    void aTransportErrorWhileCaptureIsOpenMeansTheCallEndedEarly() {
        ingest(List.of(Fixtures.select("a:1", "c1", 1, 0)), List.of());
        service.callCompleted("c1", null, "connection reset");
        assertThat(repo.summary("c1").orElseThrow().endedEarly()).isTrue();
        service.callCompleted("not-captured", 200, null); // no summary: nothing to do, no error
        assertThat(repo.summary("not-captured")).isEmpty();
    }

    @Test
    void reliveRunStatementsAreDeletedByRunAndSurviveTheSizeCap() {
        IncomingStatement tagged = new IncomingStatement("a:9", "run-call", "run_1/step-a", "t", 1, StatementKind.SELECT, "SELECT 1", "fp", null,
                List.of(), Fixtures.updated(0), null, 0, null, null, "2026-10-04T18:00:00Z", 10, 10, null, null, null, null, null);
        ingest(List.of(Fixtures.select("a:1", "old", 1, 50), tagged), List.of());

        DbCaptureRetention retention = new DbCaptureRetention(repo, Optional.of(() -> Set.of()), Optional.empty(), 1);
        retention.batchIngested(); // checks only every 20th batch
        assertThat(repo.allStatements("old", 10)).hasSize(1);
        for (int i = 0; i < 19; i++) {
            retention.batchIngested();
        }
        assertThat(repo.allStatements("old", 10)).isEmpty();
        assertThat(repo.allStatements("run-call", 10)).hasSize(1);

        assertThat(service.deleteForRuns(List.of("run%"))).isZero(); // wildcards in an id match literally
        assertThat(service.deleteForRuns(List.of("run_1"))).isEqualTo(1);
        assertThat(repo.allStatements("run-call", 10)).isEmpty();
    }

    @Test
    void anExportReimportsIntoAnEmptyStoreWithEveryRowAndIsIdempotent() throws Exception {
        ingest(List.of(Fixtures.select("a:1", "c1", 1, 1200), statement("a:2", "c1", 2, StatementKind.INSERT, "INSERT INTO audit VALUES (?)",
                        failed("23505", 1, "duplicate"), null, null)),
                List.of(new CallMarker("c1", 0, MarkerType.CALL_OPEN, "2026-10-04T18:00:00Z", null, null),
                        new CallMarker("c1", 3, MarkerType.HTTP_OUT, "2026-10-04T18:00:01Z", "POST", "https://pay.example/charge")));
        var exported = query.export("c1").orElseThrow();
        assertThat(exported.statements()).hasSize(2);
        assertThat(exported.statements().get(0).rows()).hasSize(1200);
        assertThat(query.export("not-captured")).isEmpty();

        // Into a fresh store, as a re-import on another Alfred would.
        String json = new ObjectMapper().findAndRegisterModules().writeValueAsString(exported);
        var parsed = new ObjectMapper().findAndRegisterModules().readValue(json, com.fathy.alfred.backend.dbcapture.domain.model.CallDbCaptureExport.class);
        repo.deleteAllCallStatements();
        assertThat(query.importCaptures(Map.of("c1", parsed))).isEqualTo(2);
        assertThat(query.importCaptures(Map.of("c1", parsed))).isZero();
        var again = query.export("c1").orElseThrow();
        assertThat(again.statements()).extracting(s -> s.sql()).containsExactly(exported.statements().get(0).sql(), exported.statements().get(1).sql());
        assertThat(again.statements().get(0).rows()).isEqualTo(exported.statements().get(0).rows());
        assertThat(again.supplierMarkers()).hasSize(1);
        assertThat(again.summary().statementCount()).isEqualTo(2);
    }

    @Test
    void flagsTraceTablesAndStatementQueriesWorkOnARecordedCall() {
        ingest(List.of(Fixtures.select("a:1", "c1", 1, 3),
                        statement("a:2", "c1", 2, StatementKind.DELETE, "DELETE FROM rate_cache", Fixtures.updated(212), null, null),
                        statement("a:3", "c1", 3, StatementKind.INSERT, "INSERT INTO audit VALUES (?)", failed("23505", 1, "duplicate"), null, null)),
                List.of());
        service.callCompleted("c1", 200, null);

        var flags = repo.summary("c1").orElseThrow().flags();
        assertThat(flags).extracting(f -> f.type().name()).containsExactly("NO_WHERE", "FAILED_SWALLOWED", "LARGE_DELETE", "BEFORE_NOT_CAPTURED");

        var investigation = new com.fathy.alfred.backend.dbcapture.application.service.DbCaptureInvestigationService(repo, new InMemoryQuerySandbox());
        // Fixtures.select rows: (i, "row i"); the parameter of every fixture statement is BIGINT 1042.
        assertThat(investigation.trace("c1", "row 2")).extracting(h -> h.seq() + ":" + h.where()).containsExactly("1:ROW");
        assertThat(investigation.trace("c1", "1042")).extracting(h -> h.seq()).containsExactly(1, 2, 3);
        assertThat(investigation.tables("c1")).extracting(t -> t.table()).first().isEqualTo("rate_cache");

        var query = investigation.queryStatements("c1",
                new com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryRequest("sql", "SELECT n, verb FROM statements WHERE write = 1", null, null, 0, 50));
        assertThat(query.error()).isNull();
        assertThat(query.statementSeqs()).containsExactly(2, 3);

        long selectId = repo.allStatements("c1", 10).get(0).id();
        var search = investigation.queryRows(selectId, "RESULT",
                new com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryRequest("search", "row 1", "id", "desc", 0, 50)).orElseThrow();
        assertThat(search.rows()).extracting(r -> r.get(1)).containsExactly("row 1");
    }

    @Test
    void aDeleteTakesItsRowsFromAnEarlierReadOfTheSameRows_evenFromAnEarlierBatch() {
        IncomingStatement read = statement("a:1", "c1", 1, StatementKind.SELECT, "SELECT id, name FROM users WHERE id = ?",
                Fixtures.rows(List.of(new com.fathy.alfred.backend.dbcapture.domain.model.Column("id", "BIGINT")), 1),
                List.of(List.of(com.fathy.alfred.backend.dbcapture.domain.model.TypedValue.of("BIGINT", "1042"))), null);
        ingest(List.of(read), List.of());
        ingest(List.of(statement("a:2", "c1", 2, StatementKind.DELETE, "DELETE FROM users WHERE id = ?", Fixtures.updated(1), null, null)), List.of());

        var delete = repo.allStatements("c1", 10).get(1);
        assertThat(delete.beforeImage().source()).isEqualTo("EARLIER_READ");
        assertThat(delete.beforeImage().earlierSeq()).isEqualTo(1);
        assertThat(repo.summary("c1").orElseThrow().flags()).isEmpty();
    }

    @Test
    void retentionKeepsCallsASessionCycleHolds() {
        ingest(List.of(Fixtures.select("a:1", "kept", 1, 50), Fixtures.select("a:2", "evicted", 1, 50)), List.of());
        DbCaptureRetention retention = new DbCaptureRetention(repo, Optional.of(() -> Set.of("kept")), Optional.empty(), 1);
        for (int i = 0; i < 20; i++) {
            retention.batchIngested();
        }
        assertThat(repo.allStatements("kept", 10)).hasSize(1);
        assertThat(repo.allStatements("evicted", 10)).isEmpty();
    }
}
