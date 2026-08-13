package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class SessionCycleCaptureAdapterTest {

    private final SessionCycleMetadataStorePort metadataStore = mock(SessionCycleMetadataStorePort.class);
    private final CapturedCallsStorePort capturedCallsStore = mock(CapturedCallsStorePort.class);
    private final SessionCycleCaptureAdapter adapter = new SessionCycleCaptureAdapter(metadataStore, capturedCallsStore);

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro", "t", null, status);
    }

    private static CallRecord call() {
        return new CallRecord("call-1", "https://a.com-proxy/x", "https://a.com/x", "GET", null, "t", 1.0, null, null);
    }

    @Test
    void appendsToEveryRecordingCycleAndReturnsTheirIds() {
        CallRecord call = call();
        when(metadataStore.findAll()).thenReturn(List.of(
                cycle("recording-1", SessionCycleStatus.RECORDING),
                cycle("paused-1", SessionCycleStatus.PAUSED),
                cycle("recording-2", SessionCycleStatus.RECORDING)
        ));

        List<String> capturedByCycleIds = adapter.onNewCall(call);

        assertThat(capturedByCycleIds).containsExactlyInAnyOrder("recording-1", "recording-2");
        verify(capturedCallsStore).append("recording-1", call);
        verify(capturedCallsStore).append("recording-2", call);
        verify(capturedCallsStore, never()).append("paused-1", call);
    }

    @Test
    void returnsAnEmptyListWhenNoCycleIsRecording() {
        when(metadataStore.findAll()).thenReturn(List.of(cycle("paused-1", SessionCycleStatus.PAUSED)));

        assertThat(adapter.onNewCall(call())).isEmpty();
    }

    @Test
    void returnsAnEmptyListWhenThereAreNoCyclesAtAll() {
        when(metadataStore.findAll()).thenReturn(List.of());

        assertThat(adapter.onNewCall(call())).isEmpty();
    }

    @Test
    void onCallPreparedAppendsToEveryRecordingCycleWhenTheStoreSupportsTwoPhaseCapture() {
        CallRecord call = call();
        when(capturedCallsStore.supportsTwoPhaseCapture()).thenReturn(true);
        when(metadataStore.findAll()).thenReturn(List.of(
                cycle("recording-1", SessionCycleStatus.RECORDING),
                cycle("paused-1", SessionCycleStatus.PAUSED)
        ));

        List<String> capturedByCycleIds = adapter.onCallPrepared(call);

        assertThat(capturedByCycleIds).containsExactly("recording-1");
        verify(capturedCallsStore).append("recording-1", call);
        verify(capturedCallsStore, never()).append("paused-1", call);
    }

    @Test
    void onCallPreparedDoesNothingWhenTheStoreDoesNotSupportTwoPhaseCapture() {
        when(capturedCallsStore.supportsTwoPhaseCapture()).thenReturn(false);

        List<String> capturedByCycleIds = adapter.onCallPrepared(call());

        assertThat(capturedByCycleIds).isEmpty();
        verifyNoInteractions(metadataStore);
        verify(capturedCallsStore, never()).append(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    void onCallCompletedUpdatesOnlyTheCyclesThatCapturedTheCallAtPrepareTimeRegardlessOfCurrentRecordingStatus() {
        CallRecord call = call();
        when(capturedCallsStore.supportsTwoPhaseCapture()).thenReturn(true);
        when(metadataStore.findAll()).thenReturn(List.of(
                cycle("recording-1", SessionCycleStatus.RECORDING),
                cycle("recording-2", SessionCycleStatus.RECORDING)
        ));
        adapter.onCallPrepared(call);
        // Both cycles stop recording before the call completes - the completed outcome must still
        // reach them, since they already captured it in progress.
        when(metadataStore.findAll()).thenReturn(List.of(
                cycle("recording-1", SessionCycleStatus.PAUSED),
                cycle("recording-2", SessionCycleStatus.PAUSED)
        ));

        List<String> updated = adapter.onCallCompleted(call);

        assertThat(updated).containsExactlyInAnyOrder("recording-1", "recording-2");
        verify(capturedCallsStore).completeCapturedCall("recording-1", call.id(), call.response(), call.error(), call.durationMs());
        verify(capturedCallsStore).completeCapturedCall("recording-2", call.id(), call.response(), call.error(), call.durationMs());
    }

    @Test
    void onCallCompletedReturnsEmptyWhenNoCycleCapturedTheCallAtPrepareTime() {
        CallRecord call = call();
        when(capturedCallsStore.supportsTwoPhaseCapture()).thenReturn(true);
        when(metadataStore.findAll()).thenReturn(List.of(cycle("paused-1", SessionCycleStatus.PAUSED)));
        adapter.onCallPrepared(call);

        List<String> updated = adapter.onCallCompleted(call);

        assertThat(updated).isEmpty();
        verify(capturedCallsStore, never()).completeCapturedCall(
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    void onCallCompletedFallsBackToCapturingFreshWhenTheStoreDoesNotSupportTwoPhaseCapture() {
        CallRecord call = call();
        when(capturedCallsStore.supportsTwoPhaseCapture()).thenReturn(false);
        when(metadataStore.findAll()).thenReturn(List.of(cycle("recording-1", SessionCycleStatus.RECORDING)));

        List<String> capturedByCycleIds = adapter.onCallCompleted(call);

        assertThat(capturedByCycleIds).containsExactly("recording-1");
        verify(capturedCallsStore, times(1)).append("recording-1", call);
    }
}
