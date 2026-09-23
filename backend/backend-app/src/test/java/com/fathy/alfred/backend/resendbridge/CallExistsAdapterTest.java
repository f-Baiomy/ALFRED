package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.calls.domain.model.CallDetail;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class CallExistsAdapterTest {

    private com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outbound;
    private com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inbound;
    private CallExistsAdapter adapter;

    @BeforeEach
    void setUp() {
        outbound = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase.class);
        inbound = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase.class);
        adapter = new CallExistsAdapter(outbound, inbound);
    }

    @Test
    void anOutboundCallIsFoundThroughTheOutboundSlice() {
        when(outbound.getDetail("c1")).thenReturn(Optional.of(new CallDetail(null, null)));
        when(inbound.getDetail("c1")).thenReturn(Optional.empty());

        assertThat(adapter.exists("c1")).isTrue();
    }

    @Test
    void anInboundCallIsFoundThroughTheInboundSlice() {
        when(outbound.getDetail("c2")).thenReturn(Optional.empty());
        when(inbound.getDetail("c2")).thenReturn(Optional.of(new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(null, null)));

        assertThat(adapter.exists("c2")).isTrue();
    }

    @Test
    void anUnknownCallIdIsAbsentFromBothSlices() {
        when(outbound.getDetail("missing")).thenReturn(Optional.empty());
        when(inbound.getDetail("missing")).thenReturn(Optional.empty());

        assertThat(adapter.exists("missing")).isFalse();
    }
}
