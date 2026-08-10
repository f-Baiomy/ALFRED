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
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionCycleCaptureAdapterTest {

    private final SessionCycleMetadataStorePort metadataStore = mock(SessionCycleMetadataStorePort.class);
    private final CapturedCallsStorePort capturedCallsStore = mock(CapturedCallsStorePort.class);
    private final SessionCycleCaptureAdapter adapter = new SessionCycleCaptureAdapter(metadataStore, capturedCallsStore);

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro", "t", null, status);
    }

    private static CallRecord call() {
        return new CallRecord("https://a.com-proxy/x", "https://a.com/x", "GET", null, "t", 1.0, null, null);
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
}
