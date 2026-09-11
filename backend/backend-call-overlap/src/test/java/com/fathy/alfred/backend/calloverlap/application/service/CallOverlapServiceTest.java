package com.fathy.alfred.backend.calloverlap.application.service;

import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapQuery;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CallOverlapServiceTest {

    private static final Instant FROM = Instant.parse("2024-01-01T00:00:00Z");
    private static final Instant TO = Instant.parse("2024-01-01T00:00:10Z");

    @Test
    void mergesExternalAndInternalResultsIntoOneFlatList() {
        com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase externalUseCase =
                mock(com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase.class);
        com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase internalUseCase =
                mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase.class);

        com.fathy.alfred.backend.calls.domain.model.CallRecord externalCall = new com.fathy.alfred.backend.calls.domain.model.CallRecord(
                "ext-1", "https://a.com-proxy/x", "https://a.com/x", "GET", null, "2024-01-01T00:00:01Z",
                12.5, new com.fathy.alfred.backend.calls.domain.model.ResponseData(200, null, null), null);
        com.fathy.alfred.backend.internalcalls.domain.model.CallRecord internalCall = new com.fathy.alfred.backend.internalcalls.domain.model.CallRecord(
                "int-1", "https://wildfly-proxy/y", "https://wildfly/y", "POST", null, "2024-01-01T00:00:02Z",
                5.0, null, "boom", com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.ERROR,
                "sess-1", "op-1", "wildfly");

        when(externalUseCase.getCallsInRange(FROM, TO, "", "")).thenReturn(List.of(externalCall));
        when(internalUseCase.getCallsInRange(FROM, TO, "", "", "", "", "")).thenReturn(List.of(internalCall));

        CallOverlapService service = new CallOverlapService(externalUseCase, internalUseCase);
        List<CallOverlapEntry> result = service.getOverlaps(new CallOverlapQuery(FROM, TO, "", "", "", "", "", ""));

        assertThat(result).containsExactly(
                new CallOverlapEntry("ext-1", "external", null, "2024-01-01T00:00:01Z", 12.5, 200, null),
                new CallOverlapEntry("int-1", "internal", "wildfly", "2024-01-01T00:00:02Z", 5.0, null, "boom")
        );
    }

    @Test
    void passesEveryFilterThroughToEachUnderlyingUseCase() {
        com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase externalUseCase =
                mock(com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase.class);
        com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase internalUseCase =
                mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase.class);
        when(externalUseCase.getCallsInRange(eq(FROM), eq(TO), eq("boom"), eq("example.com"))).thenReturn(List.of());
        when(internalUseCase.getCallsInRange(eq(FROM), eq(TO), eq("boom"), eq("sess-1"), eq("op-1"), eq("req-1"), eq("svc-a")))
                .thenReturn(List.of());

        CallOverlapService service = new CallOverlapService(externalUseCase, internalUseCase);
        service.getOverlaps(new CallOverlapQuery(FROM, TO, "boom", "example.com", "svc-a", "sess-1", "op-1", "req-1"));

        verify(externalUseCase).getCallsInRange(FROM, TO, "boom", "example.com");
        verify(internalUseCase).getCallsInRange(FROM, TO, "boom", "sess-1", "op-1", "req-1", "svc-a");
    }

    @Test
    void returnsAnEmptyListWhenNeitherSideHasAnyMatch() {
        com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase externalUseCase =
                mock(com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase.class);
        com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase internalUseCase =
                mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase.class);
        when(externalUseCase.getCallsInRange(FROM, TO, "", "")).thenReturn(List.of());
        when(internalUseCase.getCallsInRange(FROM, TO, "", "", "", "", "")).thenReturn(List.of());

        CallOverlapService service = new CallOverlapService(externalUseCase, internalUseCase);
        List<CallOverlapEntry> result = service.getOverlaps(new CallOverlapQuery(FROM, TO, "", "", "", "", "", ""));

        assertThat(result).isEmpty();
    }
}
