package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.callrefbridge.CallRefResolver;
import com.fathy.alfred.backend.callrefbridge.ResolvedCall;
import com.fathy.alfred.backend.triage.application.port.in.NormalizeEndpointUseCase;
import com.fathy.alfred.backend.triage.domain.EndpointPattern;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class BoardCallSignatureAdapterTest {

    private final CallRefResolver calls = mock(CallRefResolver.class);
    private final NormalizeEndpointUseCase endpoints = EndpointPattern::of;
    private final BoardCallSignatureAdapter adapter = new BoardCallSignatureAdapter(calls, endpoints);

    private static ResolvedCall call(String direction, Integer status) {
        return new ResolvedCall(direction, "id", null, "POST", "http://localhost:8080/api/orders/42", "odeysys", "t", Map.of(), "",
                status, Map.of(), "");
    }

    @Test
    void anInboundCallGivesItsOutcomeAndTriagesEndpointGrouping() {
        when(calls.resolve("inbound", "a1", null)).thenReturn(Optional.of(call("inbound", 500)));

        assertThat(adapter.signatureOf("in", "a1", null)).contains("5xx|" + EndpointPattern.of("POST", "http://localhost:8080/api/orders/42"));
    }

    @Test
    void anOutboundCapturedCallIsLookedUpInItsCycle() {
        when(calls.resolve("outbound", "b1", "c-1")).thenReturn(Optional.of(call("outbound", 404)));

        assertThat(adapter.signatureOf("out", "b1", "c-1")).hasValueSatisfying(s -> assertThat(s).startsWith("4xx|POST "));
    }

    @Test
    void anUnknownOrUnreadableCallGivesNone() {
        when(calls.resolve("inbound", "gone", null)).thenReturn(Optional.empty());
        when(calls.resolve("inbound", "broken", null)).thenThrow(new IllegalStateException("db"));

        assertThat(adapter.signatureOf("in", "gone", null)).isEmpty();
        assertThat(adapter.signatureOf("in", "broken", null)).isEmpty();
        assertThat(BoardCallSignatureAdapter.signalOf(call("inbound", null))).isEqualTo("error");
        assertThat(BoardCallSignatureAdapter.signalOf(call("inbound", 201))).isEqualTo("ok");
    }
}
