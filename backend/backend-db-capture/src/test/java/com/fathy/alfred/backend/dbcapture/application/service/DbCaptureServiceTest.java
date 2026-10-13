package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.Fixtures;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StatementFailuresObserverPort;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentDirective;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestResult;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DbCaptureServiceTest {

    private final DbCaptureStorePort store = mock(DbCaptureStorePort.class);
    private final DbCaptureNotificationPort notifications = mock(DbCaptureNotificationPort.class);
    private final DbCaptureTogglePort toggle = mock(DbCaptureTogglePort.class);
    private final List<String> ingestedCalls = new ArrayList<>();
    private final int[] batches = {0};
    private final IngestListener listener = new IngestListener() {
        @Override
        public void callIngested(String callId) {
            ingestedCalls.add(callId);
        }

        @Override
        public void batchIngested() {
            batches[0]++;
        }
    };
    private final Clock clock = Clock.fixed(Instant.parse("2026-10-04T18:00:00Z"), ZoneOffset.UTC);
    private final DbCaptureService service = new DbCaptureService(store, notifications, toggle, List.of(listener), Optional.of(clock));

    @Test
    void ingestRecountsEachTouchedCallThenSignalsItOnce() {
        when(store.saveStatements(anyList())).thenReturn(2);
        IngestBatch batch = new IngestBatch("agent-1", "wallet-app",
                List.of(Fixtures.select("a:1", "call-1", 1, 1), Fixtures.select("a:2", "call-1", 4, 1), Fixtures.select("a:3", null, 1, 1)),
                List.of(new CallMarker("call-2", 0, MarkerType.CALL_OPEN, null, null, null)), Map.of("call-1", 3L));

        IngestResult result = service.ingest(batch);

        assertThat(result).isEqualTo(new IngestResult(2, 1));
        var order = inOrder(store, notifications);
        order.verify(store).saveStatements(batch.statements());
        order.verify(store).refreshTransactions("call-1");
        order.verify(store).refreshSummary("call-1");
        verify(store).refreshSummary("call-2");
        verify(store).addDropped(Map.of("call-1", 3L));
        verify(notifications).statementsAppended("call-1", 4, true);
        verify(notifications).statementsAppended("call-2", 0, true);
        verify(notifications).outsideAppended("default task-14", 1);
        assertThat(ingestedCalls).containsExactly("call-1", "call-2");
        assertThat(batches[0]).isEqualTo(1);
    }

    @Test
    void aHeartbeatStoresTheAgentAndSignalsOnlyWhenItWasNotAlreadyAttached() {
        AgentStatus status = new AgentStatus("agent-1", "wallet-app", "1.0.0", "jvm", "WildFly", 0, 0, null);
        when(store.settings("wallet-app")).thenReturn(DbCaptureSettings.defaults());
        when(store.agents()).thenReturn(List.of());

        when(toggle.isEnabled("wallet-app")).thenReturn(true);
        assertThat(service.heartbeat(status)).isEqualTo(new AgentDirective(DbCaptureSettings.defaults(), true));
        verify(store).saveAgent(status.seenAt("2026-10-04T18:00:00Z"));
        verify(notifications).agentStatusChanged("wallet-app", true);

        when(store.agents()).thenReturn(List.of(status.seenAt("2026-10-04T17:59:55Z")));
        service.heartbeat(status);
        verify(notifications).agentStatusChanged("wallet-app", true); // still once
    }

    @Test
    void deletingNoCallsTouchesNothing() {
        assertThat(service.deleteForCalls(List.of())).isZero();
        verify(store, never()).deleteForCalls(anyList());
    }

    @Test
    void failureObserversHearOfABatchWithAFailedStatement_andOfTheCallCompleting() {
        com.fathy.alfred.backend.dbcapture.application.port.out.StatementFailuresObserverPort observer =
                mock(com.fathy.alfred.backend.dbcapture.application.port.out.StatementFailuresObserverPort.class);
        DbCaptureService withObserver = new DbCaptureService(store, notifications, toggle, List.of(listener), Optional.of(clock), List.of(observer));
        when(store.failureCounts("call-1")).thenReturn(new com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts(1, 0));

        withObserver.ingest(new IngestBatch("agent-1", "wallet-app", List.of(Fixtures.select("a:1", "call-2", 1, 1)), List.of(), Map.of()));
        verify(observer, never()).failuresChanged(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyInt(),
                org.mockito.ArgumentMatchers.anyInt());

        withObserver.ingest(new IngestBatch("agent-1", "wallet-app", List.of(Fixtures.statement("a:2", "call-1", 2,
                com.fathy.alfred.backend.dbcapture.domain.model.StatementKind.INSERT, "INSERT INTO t (a) VALUES (?)",
                Fixtures.failed("23000", 1, "duplicate"), null, null)), List.of(), Map.of()));
        verify(observer).failuresChanged("call-1", 1, 0);

        when(store.summary("call-1")).thenReturn(Optional.of(new com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary(
                "call-1", 2, 1, 0, 1, 0, 0, 100, 0, List.of(), 2, false, false)));
        when(store.failureCounts("call-1")).thenReturn(new com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts(1, 1));
        withObserver.callCompleted("call-1", 200, null);
        verify(store).markFailuresSwallowed("call-1", true);
        verify(observer).failuresChanged("call-1", 1, 1);
    }

    // ------------------------------------------------------------------------------- a completion that came before the batch

    private static CallDbSummary summaryOf(String callId, int failed, boolean complete) {
        return new CallDbSummary(callId, 2, 1, 0, failed, 0, 0, 100, 0, List.of(), 2, complete, false);
    }

    private static IncomingStatement failedInsert(String callId) {
        return Fixtures.statement("a:" + callId, callId, 2, StatementKind.INSERT, "INSERT INTO t (a) VALUES (?)",
                Fixtures.failed("23000", 1, "duplicate"), null, null);
    }

    private IngestResult ingestOf(DbCaptureService on, IncomingStatement... statements) {
        return on.ingest(new IngestBatch("agent-1", "wallet-app", List.of(statements), List.of(), Map.of()));
    }

    @Test
    void aCompletionReportedBeforeTheFirstBatchIsAppliedWhenThatBatchCreatesTheSummary() {
        StatementFailuresObserverPort observer = mock(StatementFailuresObserverPort.class);
        DbCaptureService svc = new DbCaptureService(store, notifications, toggle, List.of(listener), Optional.of(clock), List.of(observer));
        CallSignalsPublisher signals = mock(CallSignalsPublisher.class);
        svc.setSignals(signals);
        when(store.failureCounts("call-1")).thenReturn(new FailureCounts(1, 1));

        // the proxy reported the call answered 200 while the agent had stored nothing of it yet
        svc.callCompleted("call-1", 200, null);
        verify(store, never()).markComplete(anyString(), anyBoolean());
        verify(store, never()).markFailuresSwallowed(anyString(), anyBoolean());

        // the agent sends its batch: a failed statement, so the summary of the call exists from now on
        when(store.summary("call-1")).thenReturn(Optional.of(summaryOf("call-1", 1, false)));
        ingestOf(svc, failedInsert("call-1"));

        var order = inOrder(store, signals);
        order.verify(store).refreshSummary("call-1");
        order.verify(store).markFailuresSwallowed("call-1", true); // answered 200: the application carried on
        order.verify(store).markComplete("call-1", false);
        order.verify(signals).publish(org.mockito.ArgumentMatchers.argThat(ids -> ids.contains("call-1")));
        verify(observer, times(2)).failuresChanged("call-1", 1, 1); // once for the completion, once for the failure in the batch
        assertThat(ingestedCalls).containsExactly("call-1");
    }

    @Test
    void aFailureTheCallAnsweredOver500WasNotSwallowedAndADiedCallEndedEarly() {
        service.callCompleted("call-5xx", 503, null);
        service.callCompleted("call-died", null, "connection reset");
        when(store.summary("call-5xx")).thenReturn(Optional.of(summaryOf("call-5xx", 1, false)));
        when(store.summary("call-died")).thenReturn(Optional.of(summaryOf("call-died", 0, false)));

        ingestOf(service, failedInsert("call-5xx"), Fixtures.select("a:2", "call-died", 1, 1));

        verify(store).markFailuresSwallowed("call-5xx", false);
        verify(store).markComplete("call-5xx", false);
        verify(store, never()).markFailuresSwallowed(org.mockito.ArgumentMatchers.eq("call-died"), anyBoolean()); // it had no failure
        verify(store).markComplete("call-died", true); // no answer at all with the capture still open
    }

    @Test
    void aRememberedCompletionIsAppliedOnceAndForgotten() {
        service.callCompleted("call-1", 200, null);
        when(store.summary("call-1")).thenReturn(Optional.of(summaryOf("call-1", 0, false)));

        ingestOf(service, Fixtures.select("a:1", "call-1", 1, 1));
        ingestOf(service, Fixtures.select("a:2", "call-1", 2, 1));

        verify(store, times(1)).markComplete("call-1", false);
    }

    @Test
    void aCompletionThatFoundTheSummaryIsAppliedAtOnceAndNotRememberedForTheNextBatch() {
        when(store.summary("call-1")).thenReturn(Optional.of(summaryOf("call-1", 0, false)));

        service.callCompleted("call-1", 200, null);
        verify(store, times(1)).markComplete("call-1", false);
        verify(notifications).statementsAppended("call-1", 2, true);

        ingestOf(service, Fixtures.select("a:3", "call-1", 3, 1));

        verify(store, times(1)).markComplete("call-1", false);
    }

    @Test
    void aBatchForAnotherCallLeavesARememberedCompletionWaiting() {
        service.callCompleted("call-1", 200, null);
        when(store.summary("call-2")).thenReturn(Optional.of(summaryOf("call-2", 0, false)));

        ingestOf(service, Fixtures.select("a:1", "call-2", 1, 1));
        verify(store, never()).markComplete(org.mockito.ArgumentMatchers.eq("call-1"), anyBoolean());

        when(store.summary("call-1")).thenReturn(Optional.of(summaryOf("call-1", 0, false)));
        ingestOf(service, Fixtures.select("a:2", "call-1", 1, 1));
        verify(store).markComplete("call-1", false);
        verify(store, never()).markComplete(org.mockito.ArgumentMatchers.eq("call-2"), anyBoolean());
    }

    @Test
    void aCompletionStaysRememberedUntilTheCallHasASummary() {
        service.callCompleted("call-1", 200, null);

        ingestOf(service, Fixtures.select("a:1", "call-1", 1, 1)); // the store holds no summary of it yet (a dropped batch, say)
        verify(store, never()).markComplete(anyString(), anyBoolean());

        when(store.summary("call-1")).thenReturn(Optional.of(summaryOf("call-1", 0, false)));
        ingestOf(service, Fixtures.select("a:2", "call-1", 2, 1));
        verify(store, times(1)).markComplete("call-1", false);
    }

    @Test
    void aRepeatedReportOfTheCompletionReplacesTheEarlierOne() {
        service.callCompleted("call-1", 500, null);
        service.callCompleted("call-1", 200, null); // the proxy retried: the answer it ended with is the one that counts
        when(store.summary("call-1")).thenReturn(Optional.of(summaryOf("call-1", 1, false)));

        ingestOf(service, failedInsert("call-1"));

        verify(store).markFailuresSwallowed("call-1", true);
        verify(store, never()).markFailuresSwallowed("call-1", false);
    }

    @Test
    void onlyTheNewestTwoThousandEarlyCompletionsAreRemembered() {
        int total = DbCaptureService.MAX_EARLY_COMPLETIONS + 5;
        for (int i = 0; i < total; i++) {
            service.callCompleted("call-" + i, 200, null);
        }
        String newest = "call-" + (total - 1);
        for (String id : List.of("call-0", "call-4", "call-5", newest)) {
            when(store.summary(id)).thenReturn(Optional.of(summaryOf(id, 0, false)));
        }

        ingestOf(service, Fixtures.select("a:0", "call-0", 1, 1), Fixtures.select("a:4", "call-4", 1, 1),
                Fixtures.select("a:5", "call-5", 1, 1), Fixtures.select("a:n", newest, 1, 1));

        // the five oldest were forgotten to make room; the sixth and the newest are still there
        verify(store, never()).markComplete(org.mockito.ArgumentMatchers.eq("call-0"), anyBoolean());
        verify(store, never()).markComplete(org.mockito.ArgumentMatchers.eq("call-4"), anyBoolean());
        verify(store).markComplete("call-5", false);
        verify(store).markComplete(newest, false);
    }

    @Test
    void aVeryLongErrorIsKeptShortButStillMeansTheApplicationDied() {
        service.callCompleted("call-1", null, "   " + "e".repeat(50_000));
        when(store.summary("call-1")).thenReturn(Optional.of(summaryOf("call-1", 0, false)));

        ingestOf(service, Fixtures.select("a:1", "call-1", 1, 1));

        verify(store).markComplete("call-1", true); // no answer and an error: the application died mid-call
    }

    @Test
    void aCompletedCallRemembersWhatItAskedTheAgentFor() {
        var logLink = mock(com.fathy.alfred.backend.dbcapture.application.port.out.LogLinkTogglePort.class);
        service.setLogLink(logLink);
        when(toggle.isEnabled("odeysys")).thenReturn(true);
        when(logLink.isOn("odeysys")).thenReturn(true);

        service.callCompleted("call-1", 200, null, "odeysys");

        verify(store).recordCaptureAsked("call-1", "odeysys", "db,logs", "2026-10-04T18:00:00Z");
    }

    @Test
    void aCallOfAProjectWithEveryCaptureOffAskedForNothing() {
        service.callCompleted("call-1", 200, null, "odeysys");
        service.callCompleted("call-2", 200, null, null);

        verify(store, org.mockito.Mockito.never()).recordCaptureAsked(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString());
    }

    @Test
    void aDeletedInboundCallTakesItsCaptureExceptWhereACycleOrARunHoldsIt() {
        com.fathy.alfred.backend.dbcapture.application.port.out.RetainedCallIdsPort retained =
                org.mockito.Mockito.mock(com.fathy.alfred.backend.dbcapture.application.port.out.RetainedCallIdsPort.class);
        org.mockito.Mockito.when(retained.retainedCallIds()).thenReturn(java.util.Set.of("in-a-cycle"));
        org.mockito.Mockito.when(store.callsWithRunStatements(org.mockito.ArgumentMatchers.anyCollection()))
                .thenReturn(java.util.Set.of("a-relive-run-call"));
        org.mockito.Mockito.when(store.deleteForCalls(org.mockito.ArgumentMatchers.anyCollection())).thenReturn(1);
        service.setRetainedCalls(retained);

        service.callsDeleted(List.of("gone", "in-a-cycle", "a-relive-run-call"));

        org.mockito.Mockito.verify(store).deleteForCalls(List.of("gone"));
    }
}
