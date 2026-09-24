package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SessionValueLookupAdapterTest {

    private com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase outbound;
    private com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase inbound;
    private ListCapturedCallsUseCase capturedOutboundList;
    private GetCapturedCallDetailUseCase capturedOutboundDetail;
    private ListCapturedInternalCallsUseCase capturedInboundList;
    private GetCapturedInternalCallDetailUseCase capturedInboundDetail;
    private SessionValueLookupAdapter adapter;

    @BeforeEach
    void setUp() {
        outbound = mock(com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase.class);
        inbound = mock(com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase.class);
        capturedOutboundList = mock(ListCapturedCallsUseCase.class);
        capturedOutboundDetail = mock(GetCapturedCallDetailUseCase.class);
        capturedInboundList = mock(ListCapturedInternalCallsUseCase.class);
        capturedInboundDetail = mock(GetCapturedInternalCallDetailUseCase.class);
        adapter = new SessionValueLookupAdapter(outbound, inbound, capturedOutboundList, capturedOutboundDetail,
                capturedInboundList, capturedInboundDetail);
    }

    @Test
    void aLiveLookupUsesTheNewestMatchAndReportsWhichCallItCameFrom() {
        when(outbound.recentRequestHeaders("api.supplier.com", 200)).thenReturn(List.of(
                new com.fathy.alfred.backend.calls.domain.model.RecentRequestHeaders("c2", Map.of("Cookie", "s=new")),
                new com.fathy.alfred.backend.calls.domain.model.RecentRequestHeaders("c1", Map.of("Cookie", "s=old"))));

        List<SessionValue> found = adapter.newest("outbound", "api.supplier.com", Set.of("cookie"), null);

        assertThat(found).containsExactly(new SessionValue("Cookie", "s=new", "c2"));
    }

    @Test
    void aMissingNameIsSimplyNotInTheResult() {
        when(outbound.recentRequestHeaders(any(), org.mockito.ArgumentMatchers.anyInt())).thenReturn(List.of(
                new com.fathy.alfred.backend.calls.domain.model.RecentRequestHeaders("c1", Map.of("X-Other", "1"))));

        List<SessionValue> found = adapter.newest("outbound", "api.supplier.com", Set.of("cookie", "authorization"), null);

        assertThat(found).isEmpty();
    }

    @Test
    void aCycleScopedLookupScansThatCyclesCapturedCallsForTheHost() {
        var matchingSummary = new com.fathy.alfred.backend.internalcalls.domain.model.CallSummary(
                "c2", "http://localhost:9001/x", "http://localhost:9001/x", "GET", "t", 1.0, 200, null, null,
                com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.COMPLETED, null, null, "odeysys");
        var otherHostSummary = new com.fathy.alfred.backend.internalcalls.domain.model.CallSummary(
                "c-other", "http://other-host:9001/y", "http://other-host:9001/y", "GET", "t", 1.0, 200, null, null,
                com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.COMPLETED, null, null, "odeysys");
        when(capturedInboundList.listCalls(eq("cy"), any())).thenReturn(Optional.of(
                new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage(List.of(
                        new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary("cap-1", "now", matchingSummary),
                        new com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary("cap-2", "now", otherHostSummary)),
                        2)));
        when(capturedInboundDetail.getDetail("cy", "c2")).thenReturn(Optional.of(
                new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(
                        new com.fathy.alfred.backend.internalcalls.domain.model.RequestData(Map.of("Authorization", "Bearer cy"), null), null)));

        List<SessionValue> found = adapter.newest("inbound", "localhost", Set.of("authorization"), "cy");

        assertThat(found).containsExactly(new SessionValue("Authorization", "Bearer cy", "c2"));
    }

    @Test
    void withNothingFoundTheResultIsEmpty() {
        when(outbound.recentRequestHeaders(any(), org.mockito.ArgumentMatchers.anyInt())).thenReturn(List.of());

        assertThat(adapter.newest("outbound", "api.supplier.com", Set.of("cookie"), null)).isEmpty();
    }
}
