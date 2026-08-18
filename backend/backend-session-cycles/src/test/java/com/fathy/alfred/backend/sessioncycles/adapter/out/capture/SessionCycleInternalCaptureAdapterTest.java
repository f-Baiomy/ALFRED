package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
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
    private final SessionCycleInternalCaptureAdapter adapter = new SessionCycleInternalCaptureAdapter(metadataStore, capturedInternalCallsStore);

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
}
