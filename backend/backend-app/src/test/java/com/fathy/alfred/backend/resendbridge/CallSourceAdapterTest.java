package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.callrefbridge.CallRefResolver;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class CallSourceAdapterTest {

    private com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundList;
    private com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outboundDetail;
    private com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inboundList;
    private com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inboundDetail;
    private ListCapturedCallsUseCase capturedOutboundList;
    private GetCapturedCallDetailUseCase capturedOutboundDetail;
    private ListCapturedInternalCallsUseCase capturedInboundList;
    private GetCapturedInternalCallDetailUseCase capturedInboundDetail;
    private CallSourceAdapter adapter;

    @BeforeEach
    void setUp() {
        outboundList = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase.class);
        outboundDetail = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase.class);
        inboundList = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase.class);
        inboundDetail = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase.class);
        capturedOutboundList = mock(ListCapturedCallsUseCase.class);
        capturedOutboundDetail = mock(GetCapturedCallDetailUseCase.class);
        capturedInboundList = mock(ListCapturedInternalCallsUseCase.class);
        capturedInboundDetail = mock(GetCapturedInternalCallDetailUseCase.class);
        adapter = new CallSourceAdapter(new CallRefResolver(outboundList, outboundDetail, inboundList, inboundDetail,
                capturedOutboundList, capturedOutboundDetail, capturedInboundList, capturedInboundDetail));
    }

    @Test
    void anOutboundLiveCallIsAssembledFromTheSummaryAndTheDetail() {
        var summary = new com.fathy.alfred.backend.calls.domain.model.CallSummary(
                "c1", "https://api.supplier.com/fares", "https://api.supplier.com/fares", "POST", "t",
                1.0, 200, null, null);
        when(outboundList.getCalls(any())).thenReturn(
                new com.fathy.alfred.backend.calls.domain.model.CallsPage(java.util.List.of(summary), 1));
        when(outboundDetail.getDetail("c1")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(
                new com.fathy.alfred.backend.calls.domain.model.RequestData(Map.of("Authorization", "Bearer x"), "{}"), null)));

        StoredCall found = adapter.load("outbound", "c1", null).orElseThrow();

        assertThat(found.direction()).isEqualTo("outbound");
        assertThat(found.method()).isEqualTo("POST");
        assertThat(found.url()).isEqualTo("https://api.supplier.com/fares");
        assertThat(found.host()).isEqualTo("api.supplier.com");
        assertThat(found.headers()).containsEntry("Authorization", "Bearer x");
        assertThat(found.body()).isEqualTo("{}");
        verifyNoInteractions(capturedOutboundList, capturedOutboundDetail, inboundList, inboundDetail);
    }

    @Test
    void anInboundCapturedCallIsReadFromThatCycle() {
        var summary = new com.fathy.alfred.backend.internalcalls.domain.model.CallSummary(
                "c2", "http://localhost:9001/x", "http://localhost:9001/x", "GET", "t", 1.0, 200, null, null,
                com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.COMPLETED, null, null, "odeysys");
        when(capturedInboundList.listCalls(org.mockito.ArgumentMatchers.eq("cy"), any())).thenReturn(
                Optional.of(new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage(
                        java.util.List.of(new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary(
                                "captured-1", "now", summary)),
                        1)));
        when(capturedInboundDetail.getDetail("cy", "c2")).thenReturn(Optional.of(
                new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(
                        new com.fathy.alfred.backend.internalcalls.domain.model.RequestData(Map.of("Cookie", "s=1"), null), null)));

        StoredCall found = adapter.load("inbound", "c2", "cy").orElseThrow();

        assertThat(found.direction()).isEqualTo("inbound");
        assertThat(found.serviceName()).isEqualTo("odeysys");
        assertThat(found.headers()).containsEntry("Cookie", "s=1");
        verifyNoInteractions(outboundList, outboundDetail);
    }

    @Test
    void anUnknownCallIsEmpty() {
        when(outboundList.getCalls(any())).thenReturn(new com.fathy.alfred.backend.calls.domain.model.CallsPage(java.util.List.of(), 0));

        assertThat(adapter.load("outbound", "missing", null)).isEmpty();
        verifyNoInteractions(outboundDetail);
    }

    @Test
    void anUnknownDirectionIsEmpty() {
        assertThat(adapter.load("sideways", "c1", null)).isEmpty();
        verifyNoInteractions(outboundList, outboundDetail, inboundList, inboundDetail);
    }
}
