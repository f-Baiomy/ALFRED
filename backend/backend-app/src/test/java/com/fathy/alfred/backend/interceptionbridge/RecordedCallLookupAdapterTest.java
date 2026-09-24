package com.fathy.alfred.backend.interceptionbridge;

import com.fathy.alfred.backend.callrefbridge.CallRefResolver;
import com.fathy.alfred.backend.interception.application.port.out.RecordedCallLookupPort.RecordedResponse;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class RecordedCallLookupAdapterTest {

    private com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outbound;
    private com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inbound;
    private GetCapturedCallDetailUseCase capturedOutbound;
    private GetCapturedInternalCallDetailUseCase capturedInbound;
    private RecordedCallLookupAdapter adapter;

    @BeforeEach
    void setUp() {
        outbound = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase.class);
        inbound = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase.class);
        capturedOutbound = mock(GetCapturedCallDetailUseCase.class);
        capturedInbound = mock(GetCapturedInternalCallDetailUseCase.class);
        // The resolver also looks each call up in its slice's list (for method/url); a response
        // lookup must not depend on that, so the lists here never find anything.
        var outboundList = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase.class);
        when(outboundList.getCalls(any())).thenReturn(new com.fathy.alfred.backend.calls.domain.model.CallsPage(List.of(), 0));
        var inboundList = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase.class);
        when(inboundList.getCalls(any())).thenReturn(new com.fathy.alfred.backend.internalcalls.domain.model.CallsPage(List.of(), 0));
        adapter = new RecordedCallLookupAdapter(new CallRefResolver(outboundList, outbound, inboundList, inbound,
                mock(ListCapturedCallsUseCase.class), capturedOutbound,
                mock(ListCapturedInternalCallsUseCase.class), capturedInbound));
    }

    @Test
    void anOutboundCallIsReadFromTheLiveLog() {
        when(outbound.getDetail("c1")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(null,
                new com.fathy.alfred.backend.calls.domain.model.ResponseData(503, Map.of("content-type", "application/json"), "{\"e\":1}"))));

        RecordedResponse response = adapter.find("outbound", "c1", null).orElseThrow();

        assertThat(response.status()).isEqualTo(503);
        assertThat(response.headers()).containsEntry("content-type", "application/json");
        assertThat(new String(response.body(), StandardCharsets.UTF_8)).isEqualTo("{\"e\":1}");
    }

    @Test
    void anInboundCallCapturedInACycleIsReadFromThatCycle() {
        when(capturedInbound.getDetail("cy", "c2")).thenReturn(Optional.of(new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(null,
                new com.fathy.alfred.backend.internalcalls.domain.model.ResponseData(200, Map.of(), "ok"))));

        assertThat(adapter.find("inbound", "c2", "cy")).map(RecordedResponse::status).contains(200);
        verifyNoInteractions(inbound);
    }

    @Test
    void aCallWithNoResponseYetHasNothingToAnswerWith() {
        when(outbound.getDetail("c3")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(null, null)));

        assertThat(adapter.find("outbound", "c3", null)).isEmpty();
    }

    @Test
    void anUnknownDirectionFindsNothing() {
        assertThat(adapter.find("sideways", "c1", null)).isEmpty();
        verifyNoInteractions(outbound, inbound, capturedOutbound, capturedInbound);
    }
}
