package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import com.fathy.alfred.backend.sessioncycles.application.port.in.FindCapturedCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.FindCapturedInternalCallUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class CallSourceAdapterTest {

    private com.fathy.alfred.backend.calls.application.port.in.FindCallUseCase outbound;
    private com.fathy.alfred.backend.internalcalls.application.port.in.FindCallUseCase inbound;
    private FindCapturedCallUseCase capturedOutbound;
    private FindCapturedInternalCallUseCase capturedInbound;
    private CallSourceAdapter adapter;

    @BeforeEach
    void setUp() {
        outbound = mock(com.fathy.alfred.backend.calls.application.port.in.FindCallUseCase.class);
        inbound = mock(com.fathy.alfred.backend.internalcalls.application.port.in.FindCallUseCase.class);
        capturedOutbound = mock(FindCapturedCallUseCase.class);
        capturedInbound = mock(FindCapturedInternalCallUseCase.class);
        adapter = new CallSourceAdapter(outbound, inbound, capturedOutbound, capturedInbound);
    }

    @Test
    void aNullCycleIdReadsFromTheLiveLog() {
        com.fathy.alfred.backend.calls.domain.model.CallRecord record = new com.fathy.alfred.backend.calls.domain.model.CallRecord(
                "c1", "https://a.com/x", "https://a.com/x", "POST",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(Map.of("X-A", "1"), "{}"),
                "t", null, null, null);
        when(outbound.find("c1")).thenReturn(Optional.of(record));

        Optional<StoredCall> found = adapter.load("outbound", "c1", null);

        assertThat(found).isPresent();
        assertThat(found.get().method()).isEqualTo("POST");
        assertThat(found.get().headers()).containsEntry("X-A", "1");
        verifyNoInteractions(capturedOutbound);
    }

    @Test
    void aNonNullCycleIdReadsFromTheCapturedCallInsteadOfTheLiveLog() {
        com.fathy.alfred.backend.calls.domain.model.CallRecord record = new com.fathy.alfred.backend.calls.domain.model.CallRecord(
                "c1", "https://a.com/x", "https://a.com/x", "GET",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(Map.of(), null), "t", null, null, null);
        when(capturedOutbound.findCaptured("cycle-1", "c1")).thenReturn(Optional.of(new CapturedCall("wrapper-1", "t", record)));

        Optional<StoredCall> found = adapter.load("outbound", "c1", "cycle-1");

        assertThat(found).isPresent();
        assertThat(found.get().id()).isEqualTo("c1");
        verify(capturedOutbound).findCaptured("cycle-1", "c1");
        verifyNoInteractions(outbound);
    }

    @Test
    void originalUrlIsPreferredOverUrlWhenBothArePresent() {
        com.fathy.alfred.backend.calls.domain.model.CallRecord record = new com.fathy.alfred.backend.calls.domain.model.CallRecord(
                "c1", "https://client-facing/x", "https://upstream/x", "GET",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(Map.of(), null), "t", null, null, null);
        when(outbound.find("c1")).thenReturn(Optional.of(record));

        StoredCall found = adapter.load("outbound", "c1", null).orElseThrow();

        assertThat(found.originalUrl()).isEqualTo("https://client-facing/x");
    }
}
