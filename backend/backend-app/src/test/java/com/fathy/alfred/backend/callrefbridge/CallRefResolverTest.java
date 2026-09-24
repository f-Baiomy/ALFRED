package com.fathy.alfred.backend.callrefbridge;

import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class CallRefResolverTest {

    private com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundList;
    private com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outboundDetail;
    private com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inboundList;
    private com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inboundDetail;
    private ListCapturedCallsUseCase capturedOutboundList;
    private GetCapturedCallDetailUseCase capturedOutboundDetail;
    private ListCapturedInternalCallsUseCase capturedInboundList;
    private GetCapturedInternalCallDetailUseCase capturedInboundDetail;
    private CallRefResolver resolver;

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
        resolver = new CallRefResolver(outboundList, outboundDetail, inboundList, inboundDetail,
                capturedOutboundList, capturedOutboundDetail, capturedInboundList, capturedInboundDetail);
    }

    private static com.fathy.alfred.backend.calls.domain.model.CallSummary outboundSummary(String id) {
        return new com.fathy.alfred.backend.calls.domain.model.CallSummary(
                id, "https://api.supplier.com/fares", "https://api.supplier.com/fares", "POST", "t1",
                1.0, 200, null, null);
    }

    private static com.fathy.alfred.backend.internalcalls.domain.model.CallSummary inboundSummary(String id) {
        return new com.fathy.alfred.backend.internalcalls.domain.model.CallSummary(
                id, "http://localhost:9001/x", "http://localhost:9001/x", "GET", "t2", 1.0, 200, null, null,
                com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.COMPLETED, null, null, "odeysys");
    }

    @Test
    void anOutboundLiveCallCombinesItsSummaryAndDetail() {
        when(outboundList.getCalls(any())).thenReturn(
                new com.fathy.alfred.backend.calls.domain.model.CallsPage(List.of(outboundSummary("c1")), 1));
        when(outboundDetail.getDetail("c1")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(
                new com.fathy.alfred.backend.calls.domain.model.RequestData(Map.of("Authorization", "Bearer x"), "{}"),
                new com.fathy.alfred.backend.calls.domain.model.ResponseData(503, Map.of("content-type", "application/json"), "{\"e\":1}"))));

        ResolvedCall call = resolver.resolve("outbound", "c1", null).orElseThrow();

        assertThat(call.direction()).isEqualTo("outbound");
        assertThat(call.id()).isEqualTo("c1");
        assertThat(call.cycleId()).isNull();
        assertThat(call.method()).isEqualTo("POST");
        assertThat(call.url()).isEqualTo("https://api.supplier.com/fares");
        assertThat(call.timestamp()).isEqualTo("t1");
        assertThat(call.serviceName()).isNull();
        assertThat(call.requestHeaders()).containsEntry("Authorization", "Bearer x");
        assertThat(call.requestBody()).isEqualTo("{}");
        assertThat(call.responseStatus()).isEqualTo(503);
        assertThat(call.responseHeaders()).containsEntry("content-type", "application/json");
        assertThat(call.responseBody()).isEqualTo("{\"e\":1}");
        verifyNoInteractions(capturedOutboundList, capturedOutboundDetail, inboundList, inboundDetail);
    }

    @Test
    void anInboundLiveCallCarriesItsServiceName() {
        when(inboundList.getCalls(any())).thenReturn(
                new com.fathy.alfred.backend.internalcalls.domain.model.CallsPage(List.of(inboundSummary("c2")), 1));
        when(inboundDetail.getDetail("c2")).thenReturn(Optional.of(new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(
                new com.fathy.alfred.backend.internalcalls.domain.model.RequestData(Map.of("Cookie", "s=1"), null),
                new com.fathy.alfred.backend.internalcalls.domain.model.ResponseData(200, Map.of(), "ok"))));

        ResolvedCall call = resolver.resolve("inbound", "c2", null).orElseThrow();

        assertThat(call.direction()).isEqualTo("inbound");
        assertThat(call.method()).isEqualTo("GET");
        assertThat(call.serviceName()).isEqualTo("odeysys");
        assertThat(call.requestHeaders()).containsEntry("Cookie", "s=1");
        assertThat(call.responseStatus()).isEqualTo(200);
        assertThat(call.responseBody()).isEqualTo("ok");
        verifyNoInteractions(outboundList, outboundDetail, capturedInboundList, capturedInboundDetail);
    }

    @Test
    void anOutboundCapturedCallIsReadFromThatCycle() {
        when(capturedOutboundList.listCalls(eq("cy"), any())).thenReturn(Optional.of(
                new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage(List.of(
                        new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary(
                                "captured-1", "now", outboundSummary("c3"))), 1)));
        when(capturedOutboundDetail.getDetail("cy", "c3")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(
                new com.fathy.alfred.backend.calls.domain.model.RequestData(Map.of(), "body"),
                new com.fathy.alfred.backend.calls.domain.model.ResponseData(201, Map.of(), null))));

        ResolvedCall call = resolver.resolve("outbound", "c3", "cy").orElseThrow();

        assertThat(call.cycleId()).isEqualTo("cy");
        assertThat(call.url()).isEqualTo("https://api.supplier.com/fares");
        assertThat(call.requestBody()).isEqualTo("body");
        assertThat(call.responseStatus()).isEqualTo(201);
        verifyNoInteractions(outboundList, outboundDetail);
    }

    @Test
    void anInboundCapturedCallIsReadFromThatCycle() {
        when(capturedInboundList.listCalls(eq("cy"), any())).thenReturn(Optional.of(
                new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage(List.of(
                        new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary(
                                "captured-2", "now", inboundSummary("c4"))), 1)));
        when(capturedInboundDetail.getDetail("cy", "c4")).thenReturn(Optional.of(new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(
                new com.fathy.alfred.backend.internalcalls.domain.model.RequestData(Map.of("Cookie", "s=2"), null),
                new com.fathy.alfred.backend.internalcalls.domain.model.ResponseData(204, Map.of(), null))));

        ResolvedCall call = resolver.resolve("inbound", "c4", "cy").orElseThrow();

        assertThat(call.cycleId()).isEqualTo("cy");
        assertThat(call.serviceName()).isEqualTo("odeysys");
        assertThat(call.requestHeaders()).containsEntry("Cookie", "s=2");
        assertThat(call.responseStatus()).isEqualTo(204);
        verifyNoInteractions(inboundList, inboundDetail);
    }

    @Test
    void anUnknownDirectionIsEmpty() {
        assertThat(resolver.resolve("sideways", "c1", null)).isEmpty();
        assertThat(resolver.resolveListed("sideways", "c1", null)).isEmpty();
        verifyNoInteractions(outboundList, outboundDetail, inboundList, inboundDetail,
                capturedOutboundList, capturedOutboundDetail, capturedInboundList, capturedInboundDetail);
    }

    @Test
    void aMissingCallIsEmpty() {
        when(outboundList.getCalls(any())).thenReturn(new com.fathy.alfred.backend.calls.domain.model.CallsPage(List.of(), 0));

        assertThat(resolver.resolve("outbound", "missing", null)).isEmpty();
        assertThat(resolver.resolveListed("outbound", "missing", null)).isEmpty();
    }

    @Test
    void aCallTheListMissesIsStillResolvedButNotListed() {
        // The list lookup is a requestId substring filter with a page of one, so it can miss a call
        // the detail lookup finds.
        when(outboundList.getCalls(any())).thenReturn(
                new com.fathy.alfred.backend.calls.domain.model.CallsPage(List.of(outboundSummary("c10")), 1));
        when(outboundDetail.getDetail("c1")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(null,
                new com.fathy.alfred.backend.calls.domain.model.ResponseData(200, null, "ok"))));

        ResolvedCall call = resolver.resolve("outbound", "c1", null).orElseThrow();

        assertThat(call.method()).isNull();
        assertThat(call.url()).isNull();
        assertThat(call.requestHeaders()).isEmpty();
        assertThat(call.responseHeaders()).isEmpty();
        assertThat(call.responseStatus()).isEqualTo(200);
        assertThat(resolver.resolveListed("outbound", "c1", null)).isEmpty();
    }

    @Test
    void anInFlightCallHasNoResponse() {
        when(outboundList.getCalls(any())).thenReturn(
                new com.fathy.alfred.backend.calls.domain.model.CallsPage(List.of(outboundSummary("c5")), 1));
        when(outboundDetail.getDetail("c5")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(
                new com.fathy.alfred.backend.calls.domain.model.RequestData(Map.of(), "{}"), null)));

        ResolvedCall call = resolver.resolve("outbound", "c5", null).orElseThrow();

        assertThat(call.responseStatus()).isNull();
        assertThat(call.responseHeaders()).isEmpty();
        assertThat(call.responseBody()).isNull();
        assertThat(call.requestBody()).isEqualTo("{}");
    }
}
