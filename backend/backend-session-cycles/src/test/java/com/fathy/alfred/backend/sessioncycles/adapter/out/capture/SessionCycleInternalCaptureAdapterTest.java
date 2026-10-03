package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ReliveRunCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionCycleInternalCaptureAdapterTest {

    private final SessionCycleMetadataStorePort metadataStore = mock(SessionCycleMetadataStorePort.class);
    private final CapturedInternalCallsStorePort capturedInternalCallsStore = mock(CapturedInternalCallsStorePort.class);
    private final ReliveRunCyclesUseCase runCycles = mock(ReliveRunCyclesUseCase.class);
    private final SessionCycleInternalCaptureAdapter adapter = new SessionCycleInternalCaptureAdapter(metadataStore, capturedInternalCallsStore, runCycles);

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro", "t", null, status);
    }

    private static CallRecord call() {
        return new CallRecord("call-1", "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, "t", 1.0, null, null);
    }

    @Test
    void appendsToEveryRecordingCycleAndReturnsTheirIds() {
        CallRecord call = call();
        when(metadataStore.findAll()).thenReturn(List.of(
                cycle("recording-1", SessionCycleStatus.RECORDING),
                cycle("paused-1", SessionCycleStatus.PAUSED),
                cycle("recording-2", SessionCycleStatus.RECORDING)
        ));

        List<String> capturedByCycleIds = adapter.onCallCompleted(call);

        assertThat(capturedByCycleIds).containsExactlyInAnyOrder("recording-1", "recording-2");
        verify(capturedInternalCallsStore).append("recording-1", call);
        verify(capturedInternalCallsStore).append("recording-2", call);
        verify(capturedInternalCallsStore, never()).append("paused-1", call);
    }

    @Test
    void returnsAnEmptyListWhenNoCycleIsRecording() {
        when(metadataStore.findAll()).thenReturn(List.of(cycle("paused-1", SessionCycleStatus.PAUSED)));

        assertThat(adapter.onCallCompleted(call())).isEmpty();
    }

    @Test
    void returnsAnEmptyListWhenThereAreNoCyclesAtAll() {
        when(metadataStore.findAll()).thenReturn(List.of());

        assertThat(adapter.onCallCompleted(call())).isEmpty();
    }

    @Test
    void aCallOfAReliveRunGoesOnlyToThatRunsCycleNeverToARecordingOne() throws Exception {
        CallRecord call = mock(CallRecord.class);
        when(call.id()).thenReturn("run-call");
        when(call.relive()).thenReturn(new com.fasterxml.jackson.databind.ObjectMapper().readTree("{\"runId\":\"run-7\",\"stepKey\":\"s1\"}"));
        when(runCycles.captureCycleId("run-7")).thenReturn("run-cycle-7");
        when(metadataStore.findAll()).thenReturn(List.of(cycle("recording-1", SessionCycleStatus.RECORDING)));

        assertThat(adapter.onCallCompleted(call)).containsExactly("run-cycle-7");
        verify(capturedInternalCallsStore).append("run-cycle-7", call);
        verify(capturedInternalCallsStore, never()).append("recording-1", call);
    }

    @Test
    void aRunsOwnCycleNeverCapturesOtherCallsEvenIfMarkedRecording() {
        CallRecord call = call();
        when(metadataStore.findAll()).thenReturn(List.of(
                new SessionCycle("run-cycle", "Run", "t", null, SessionCycleStatus.RECORDING, "run-1", null),
                cycle("recording-1", SessionCycleStatus.RECORDING)));

        assertThat(adapter.onCallCompleted(call)).containsExactly("recording-1");
    }
}
