package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.calls.domain.model.CallInterception;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class SessionCycleCaptureAdapterTest {

    private final SessionCycleMetadataStorePort metadataStore = mock(SessionCycleMetadataStorePort.class);
    private final CapturedCallsStorePort capturedCallsStore = mock(CapturedCallsStorePort.class);
    private final CycleSpacersStorePort spacersStore = mock(CycleSpacersStorePort.class);
    private final SessionCycleCaptureAdapter adapter = new SessionCycleCaptureAdapter(metadataStore, capturedCallsStore, spacersStore);

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
    void onNewCallReAnchorsAnyTrailingSpacerToTheJustCapturedCallSoItStaysPutInsteadOfSlidingPastFutureCalls() {
        CallRecord call = call();
        when(metadataStore.findAll()).thenReturn(List.of(cycle("recording-1", SessionCycleStatus.RECORDING)));
        CycleSpacer trailing = new CycleSpacer("spacer-1", "recording-1", "End of repro", null, "t");
        CycleSpacer alreadyAnchored = new CycleSpacer("spacer-2", "recording-1", "Mid repro", "some-other-call", "t");
        when(spacersStore.findAllByCycle("recording-1")).thenReturn(List.of(trailing, alreadyAnchored));

        adapter.onNewCall(call);

        verify(spacersStore).move("recording-1", "spacer-1", call.id());
        verify(spacersStore, never()).move("recording-1", "spacer-2", call.id());
    }

    @Test
    void onNewCallDoesNotAnchorATrailingSpacerToAnOptionsPreflightSinceThatWouldMakeItVanishFromEveryView() {
        CallRecord optionsCall = new CallRecord("call-1", "https://a.com-proxy/x", "https://a.com/x", "OPTIONS", null, "t", 1.0, null, null);
        when(metadataStore.findAll()).thenReturn(List.of(cycle("recording-1", SessionCycleStatus.RECORDING)));
        CycleSpacer trailing = new CycleSpacer("spacer-1", "recording-1", "End of repro", null, "t");
        when(spacersStore.findAllByCycle("recording-1")).thenReturn(List.of(trailing));

        adapter.onNewCall(optionsCall);

        verify(spacersStore, never()).move(any(), any(), any());
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
        verify(capturedCallsStore).completeCapturedCall("recording-1", call.id(), call.response(), call.error(), call.durationMs(), call.timing(), call.interception());
        verify(capturedCallsStore).completeCapturedCall("recording-2", call.id(), call.response(), call.error(), call.durationMs(), call.timing(), call.interception());
    }

    @Test
    void onCallCompletedForwardsInterceptionSoAnEditedCallStaysMarkedEditedOnceCaptured() {
        // This used to be dropped on the floor: completeCapturedCall had no interception parameter
        // at all, so a call the live list showed as EDITED - with its own "what changed" panel -
        // showed neither once captured into a cycle, even though the SAME CallRecord carried it.
        CallInterception interception = new CallInterception(
                List.of(new CallInterception.Applied("rule-1", "Slow Sabre", "SET_RESPONSE_STATUS", "500 -> 200")),
                null, null, null, null);
        CallRecord call = new CallRecord("call-1", "https://a.com-proxy/x", "https://a.com/x", "GET",
                null, "t", 1.0, null, null, com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus.COMPLETED,
                null, null, null, null, interception);
        when(capturedCallsStore.supportsTwoPhaseCapture()).thenReturn(true);
        when(metadataStore.findAll()).thenReturn(List.of(cycle("recording-1", SessionCycleStatus.RECORDING)));
        adapter.onCallPrepared(call);

        adapter.onCallCompleted(call);

        verify(capturedCallsStore).completeCapturedCall("recording-1", "call-1", call.response(), call.error(),
                call.durationMs(), call.timing(), interception);
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
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
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
