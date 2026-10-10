package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.calls.application.port.in.SetStorageBudgetUseCase;
import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.dbcapture.application.port.in.SetCaptureBudgetUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.SetRetentionUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CleanupCandidate;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryCommand;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.sessioncycles.application.port.in.DeleteSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class StorageServiceTest {

    @TempDir
    Path dir;

    private final com.fathy.alfred.backend.calls.application.port.out.CallLogPort outbound =
            mock(com.fathy.alfred.backend.calls.application.port.out.CallLogPort.class);
    private final com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort inbound =
            mock(com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort.class);
    private final SetStorageBudgetUseCase outboundLimits = mock(SetStorageBudgetUseCase.class);
    private final SetRetentionUseCase inboundLimits = mock(SetRetentionUseCase.class);
    private final SetCaptureBudgetUseCase captureLimits = mock(SetCaptureBudgetUseCase.class);
    private final CommentsStorePort comments = mock(CommentsStorePort.class);
    private final ListSessionCyclesUseCase cycles = mock(ListSessionCyclesUseCase.class);
    private final DeleteSessionCycleUseCase deleteCycle = mock(DeleteSessionCycleUseCase.class);
    private final ManageReliveCyclesUseCase reliveCycles = mock(ManageReliveCyclesUseCase.class);
    private final ListRunsUseCase runs = mock(ListRunsUseCase.class);
    private final DeleteRunHistoryUseCase deleteRuns = mock(DeleteRunHistoryUseCase.class);
    private final ManageLogSourcesUseCase logSources = mock(ManageLogSourcesUseCase.class);
    private StorageFiles files;
    private StorageService service;

    @BeforeEach
    void setUp() {
        String d = dir.toString() + "/";
        files = new StorageFiles(d + "calls.db", d + "internal-calls.db", d + "db-capture.db", d + "logs.db", d + "triage.db",
                d + "session-cycles.db", d + "comments.db", d + "relive.db", d + "scenarios.db", d + "settings.db", d + "profiles.db",
                d + "redactions.db", d + "interception.db");
        when(inbound.statusBreakdown()).thenReturn(new com.fathy.alfred.backend.internalcalls.domain.model.CallStatusBreakdown(0, 0, 0, 0, 0));
        when(outbound.statusBreakdown()).thenReturn(new com.fathy.alfred.backend.calls.domain.model.CallStatusBreakdown(0, 0, 0, 0, 0));
        service = new StorageService(files, outbound, inbound, outboundLimits, inboundLimits, captureLimits, comments, cycles,
                deleteCycle, reliveCycles, runs, deleteRuns, logSources,
                Optional.of(Clock.fixed(Instant.parse("2026-10-10T12:00:00Z"), ZoneOffset.UTC)));
    }

    @Test
    void savingABudgetGivesEachSliceItsShareAndRemembersIt() {
        long gb = StorageBudget.GB;
        StorageBudget budget = new StorageBudget(5 * gb, "recommended", Map.of(), 7000, 0, 10, Map.of());

        service.saveBudget(budget);

        verify(inboundLimits).setRetentionRows(7000);
        verify(inboundLimits).setMaxSizeBytes((long) Math.floor(5 * gb * 0.55));
        verify(outboundLimits).setMaxRows(0);
        verify(outboundLimits).setMaxSizeBytes((long) Math.floor(5 * gb * 0.10));
        verify(outboundLimits).trimNow();
        verify(captureLimits).setCombinedMaxBytes((long) Math.floor(5 * gb * 0.20));
        assertThat(files.loadBudget().bytes()).isEqualTo(5 * gb);
        assertThat(files.history()).first().satisfies(h -> assertThat(h.what()).contains("5 GB"));
    }

    @Test
    void withoutACallLimitTheInboundSizeShareDoesTheLimiting() {
        service.saveBudget(new StorageBudget(5 * StorageBudget.GB, "recommended", Map.of(), 0, 0, 0, Map.of()));

        verify(inboundLimits).setRetentionRows(StorageService.NO_CALL_LIMIT);
    }

    @Test
    void removingTheBudgetHandsCapturesBackToTheirOwnLimits() {
        service.saveBudget(new StorageBudget(null, "recommended", Map.of(), 0, 0, 0, Map.of()));

        verify(captureLimits).setCombinedMaxBytes(0);
        verify(inboundLimits, never()).setMaxSizeBytes(org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    void aCleanUpPreviewsWithoutDeletingAndKeepsCommentedCalls() {
        when(inbound.cleanupCandidates(any(), anyInt())).thenReturn(List.of(
                new CleanupCandidate("a", "GET", "/x", 200, "2026-10-01T00:00:00Z", "odeysys", 1000),
                new CleanupCandidate("b", "GET", "/y", 500, "2026-10-01T00:00:01Z", "odeysys", 2000)));
        when(comments.findAll()).thenReturn(List.of(new Comment("c1", "b", "body", 0, "x", "note", "2026-10-01T00:00:00Z")));

        StorageService.CleanupResult preview = service.cleanup(
                new StorageService.CleanupRequest("inbound", 7, null, null, null, true, false), false);

        assertThat(preview.count()).isEqualTo(1);
        assertThat(preview.kept()).isEqualTo(1);
        assertThat(preview.bytes()).isEqualTo(1000);
        verify(inbound, never()).deleteByIds(anyCollection());

        service.cleanup(new StorageService.CleanupRequest("inbound", 7, null, null, null, true, false), true);
        verify(inbound).deleteByIds(List.of("a"));
    }

    @Test
    void theCleanUpFilterCarriesTheAgeAsAnInstant() {
        when(inbound.cleanupCandidates(any(), anyInt())).thenReturn(List.of());

        service.cleanup(new StorageService.CleanupRequest("inbound", 7, "odeysys", "5xx", "/api", false, false), false);

        verify(inbound).cleanupCandidates(eq(new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(
                "2026-10-03T12:00:00Z", "odeysys", "5xx", "/api")), anyInt());
    }

    @Test
    void reliveKeepsTheNewestRunsOfEachCycleAndNeverARunningOne() {
        ReliveCycleSummary cycle = mock(ReliveCycleSummary.class);
        when(cycle.id()).thenReturn("cyc");
        when(reliveCycles.list()).thenReturn(List.of(cycle));
        Run running = run("r4", RunStatus.RUNNING);
        Run newest = run("r3", RunStatus.COMPLETED);
        Run older = run("r2", RunStatus.FAILED);
        Run oldest = run("r1", RunStatus.COMPLETED);
        when(runs.list("cyc", 10_000)).thenReturn(List.of(newest, running, older, oldest));
        when(deleteRuns.delete(eq("cyc"), any())).thenReturn(new DeleteRunHistoryUseCase.DeletedRunHistory(2, true));

        int removed = service.trimReliveRuns(new StorageBudget(5 * StorageBudget.GB, "recommended", Map.of(), 0, 0, 1, Map.of()));

        assertThat(removed).isEqualTo(2);
        verify(deleteRuns).delete("cyc", new DeleteRunHistoryCommand(List.of("r2", "r1"), true));
    }

    @Test
    void freeingSpaceGivesEmptyPagesBackAndDeletesNothing() throws Exception {
        Path logs = dir.resolve("logs.db");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + logs); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE t (v TEXT)");
            s.execute("INSERT INTO t VALUES ('keep')");
            for (int i = 0; i < 300; i++) {
                s.execute("INSERT INTO t VALUES ('" + "x".repeat(4000) + "')");
            }
            s.execute("DELETE FROM t WHERE v <> 'keep'");
        }
        assertThat(SqliteFiles.stats(logs).freeBytes()).isGreaterThan(500_000);

        StorageService.Compacted done = service.compact("logs.db");

        assertThat(done.running()).isFalse();
        assertThat(done.freedBytes()).isGreaterThan(500_000);
        assertThat(SqliteFiles.stats(logs).freeBytes()).isZero();
        assertThat(SqliteFiles.number(logs, "SELECT COUNT(*) FROM t").orElseThrow()).isEqualTo(1);
    }

    @Test
    void aStarredRunSurvivesKeepLastN() {
        ReliveCycleSummary cycle = mock(ReliveCycleSummary.class);
        when(cycle.id()).thenReturn("cyc");
        when(reliveCycles.list()).thenReturn(List.of(cycle));
        List<Run> list = List.of(run("r3", RunStatus.COMPLETED), run("r2", RunStatus.FAILED), run("r1", RunStatus.COMPLETED));
        when(runs.list("cyc", 10_000)).thenReturn(list);
        when(deleteRuns.delete(eq("cyc"), any())).thenReturn(new DeleteRunHistoryUseCase.DeletedRunHistory(1, true));
        service.star("r1", true);

        service.trimReliveRuns(new StorageBudget(5 * StorageBudget.GB, "recommended", Map.of(), 0, 0, 1, Map.of()));

        verify(deleteRuns).delete("cyc", new DeleteRunHistoryCommand(List.of("r2"), true));
        service.star("r1", false);
        assertThat(files.starredRuns()).isEmpty();
    }

    @Test
    void deletingChosenCallsKeepsCommentedOnesAndSaysHowMany() {
        when(comments.findAll()).thenReturn(List.of(new Comment("c1", "kept", "body", 0, "x", "note", "2026-10-01T00:00:00Z")));
        when(inbound.deleteByIds(anyCollection())).thenAnswer(a -> ((java.util.Collection<?>) a.getArgument(0)).size());

        StorageService.Deleted d = service.deleteCalls(new StorageService.DeleteRequest(List.of("a", "kept"), List.of(), "GET /hb"));

        verify(inbound).deleteByIds(List.of("a"));
        assertThat(d.count()).isEqualTo(1);
        assertThat(d.kept()).isEqualTo(1);
        assertThat(files.history().get(0).what()).contains("GET /hb");
    }

    @Test
    void thePreflightRuleRemovesOptionsCallsOnItsOwn() {
        StorageBudget withRule = new StorageBudget(null, "recommended", Map.of(), 0, 0, 0, Map.of(),
                new StorageBudget.Rules(true, "", 0, 0, false, false));
        files.saveBudget(withRule);
        when(inbound.cleanupCandidates(any(), anyInt())).thenReturn(List.of(
                new CleanupCandidate("pre", "OPTIONS", "/x", 204, "2026-10-01T00:00:00Z", "o", 10)));
        when(outbound.cleanupCandidates(any(), anyInt())).thenReturn(List.of());

        service.sweepOften();

        verify(inbound).cleanupCandidates(eq(new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(null, null, "options", null)), anyInt());
        verify(inbound).deleteByIds(List.of("pre"));
        assertThat(files.history().get(0).who()).isEqualTo("auto");
    }

    @Test
    void foldingWriteLogsAndCheckingFilesTouchNoData() throws Exception {
        Path calls = dir.resolve("calls.db");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + calls); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE t (v TEXT)");
            s.execute("INSERT INTO t VALUES ('x')");
        }

        assertThat(service.files(true)).singleElement().satisfies(f -> {
            assertThat(f.name()).isEqualTo("calls.db");
            assertThat(f.check()).isEqualTo("ok");
        });
        service.checkpointAll();
        assertThat(SqliteFiles.number(calls, "SELECT COUNT(*) FROM t").orElseThrow()).isEqualTo(1);
    }

    private static Run run(String id, RunStatus status) {
        Run r = mock(Run.class);
        when(r.id()).thenReturn(id);
        when(r.status()).thenReturn(status);
        return r;
    }
}
