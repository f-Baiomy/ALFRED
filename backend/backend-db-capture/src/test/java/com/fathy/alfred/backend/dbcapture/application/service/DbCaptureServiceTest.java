package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.Fixtures;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
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
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
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
}
