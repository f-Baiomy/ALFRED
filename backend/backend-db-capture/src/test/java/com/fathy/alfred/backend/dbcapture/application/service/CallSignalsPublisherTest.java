package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.CallSignalsObserverPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlag;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlagType;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.Thresholds;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** A call's log and database signals reach triage whenever they may have changed (specs/010-mcp-log-investigation). */
class CallSignalsPublisherTest {

    private final DbCaptureStorePort store = mock(DbCaptureStorePort.class);
    private final CallSignalsObserverPort observer = mock(CallSignalsObserverPort.class);
    private final CallSignalsPublisher publisher = new CallSignalsPublisher(store, List.of(observer));

    private static CallDbSummary summary(String callId, List<DbFlag> flags) {
        return new CallDbSummary(callId, 12, 0, 0, 1, 1, 0, 100, 0, flags, 12, true, false);
    }

    private static DbFlag flag(DbFlagType type) {
        return new DbFlag(type, DbFlag.WARN, List.of(1), null, Map.of());
    }

    @Test
    void countsLevelAndEveryFlagButTheFailuresAreHandedOn() {
        when(store.logCounts(List.of("c1"))).thenReturn(Map.of("c1", new CaughtLogCounts(30, 5, 1, 0, 2)));
        when(store.summary("c1")).thenReturn(Optional.of(summary("c1", List.of(flag(DbFlagType.FAILED_SWALLOWED), flag(DbFlagType.REPEATED_QUERY),
                flag(DbFlagType.SLOW), flag(DbFlagType.SLOW)))));
        when(store.callLogLevel("c1")).thenReturn(Optional.of("WARN"));

        publisher.publish(List.of("c1"));

        verify(observer).signalsChanged("c1", 5, 1, 2, "CAUGHT", "WARN", List.of("REPEATED_QUERY", "SLOW"), 0, 0);
    }

    @Test
    void aCallWithNoLinesAndNoCaptureSaysSo() {
        when(store.logCounts(List.of("c2"))).thenReturn(Map.of());
        when(store.summary("c2")).thenReturn(Optional.empty());
        when(store.callLogLevel("c2")).thenReturn(Optional.empty());

        publisher.publish(List.of("c2"));

        verify(observer).signalsChanged("c2", 0, 0, 0, null, null, List.of(), 0, 0);
    }

    @Test
    void aBatchWithLinesOrStatementsAndACompletedCallPublish() {
        DbCaptureService service = new DbCaptureService(store, mock(DbCaptureNotificationPort.class), mock(DbCaptureTogglePort.class), List.of(),
                Optional.of(Clock.systemUTC()));
        service.setSignals(publisher);
        when(store.logCounts(any())).thenReturn(Map.of());
        when(store.summary(anyString())).thenReturn(Optional.empty());
        when(store.callLogLevel(anyString())).thenReturn(Optional.empty());

        service.ingest(new IngestBatch("agent-1", "odeysys", List.of(), List.of(), Map.of(), List.of(
                new CaughtLogLine(0, "c-log", 1, "2026-10-06T10:00:00Z", "ERROR", "L", "t", "boom", null, null, null, false, "odeysys"),
                new CaughtLogLine(0, null, 0, "2026-10-06T10:00:00Z", "ERROR", "L", "t", "outside", null, null, null, false, "odeysys")), Map.of()));
        verify(observer).signalsChanged(eq("c-log"), anyInt(), anyInt(), anyInt(), any(), any(), any(), anyInt(), anyInt());

        when(store.summary("c-done")).thenReturn(Optional.of(summary("c-done", List.of())));
        service.callCompleted("c-done", 200, null);
        verify(observer).signalsChanged(eq("c-done"), anyInt(), anyInt(), anyInt(), any(), any(), any(), anyInt(), anyInt());
    }

    @Test
    void changingAProjectsThresholdsReflagsItsCallsInBatchesAndOtherChangesDoNot() {
        when(store.callIdsOfProject("odeysys", 0, CallSignalsPublisher.BATCH)).thenReturn(List.of("a", "b"));
        when(store.summaryRowId("b")).thenReturn(2L);
        when(store.callIdsOfProject("odeysys", 2, CallSignalsPublisher.BATCH)).thenReturn(List.of());
        when(store.logCounts(any())).thenReturn(Map.of());
        when(store.summary(anyString())).thenReturn(Optional.empty());
        when(store.callLogLevel(anyString())).thenReturn(Optional.empty());

        publisher.reflagNow("odeysys");
        verify(observer).signalsChanged(eq("a"), anyInt(), anyInt(), anyInt(), any(), any(), any(), anyInt(), anyInt());
        verify(observer).signalsChanged(eq("b"), anyInt(), anyInt(), anyInt(), any(), any(), any(), anyInt(), anyInt());

        // through the settings save: only a change that can move flags starts a re-flag
        CallSignalsPublisher spy = mock(CallSignalsPublisher.class);
        DbCaptureProjectsService projects = new DbCaptureProjectsService(store, mock(DbCaptureTogglePort.class),
                mock(com.fathy.alfred.backend.dbcapture.application.port.out.LogLinkTogglePort.class), mock(DbCaptureNotificationPort.class),
                Optional.empty(), Optional.empty());
        projects.setSignals(spy);
        DbCaptureSettings current = DbCaptureSettings.defaults();
        when(store.settings("odeysys")).thenReturn(current);
        projects.saveSettings("odeysys", new DbCaptureSettings(current.rowsPerResult(), current.beforeImageTables(), current.outsideCallCapture(),
                current.thresholds(), current.expectedFingerprints(), current.ignorePatterns(), current.passThroughClasses(), current.callerFrames(),
                current.indexInfo(), "WARN"));
        verify(spy, never()).reflagProject(anyString());
        projects.saveSettings("odeysys", new DbCaptureSettings(current.rowsPerResult(), current.beforeImageTables(), current.outsideCallCapture(),
                new Thresholds(1, current.thresholds().hugeRows(), current.thresholds().repeatCount(), current.thresholds().largeDeleteRows()),
                current.expectedFingerprints(), current.ignorePatterns(), current.passThroughClasses(), current.callerFrames(), current.indexInfo(), "WARN"));
        verify(spy).reflagProject("odeysys");
    }
}
