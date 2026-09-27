package com.fathy.alfred.backend.resend.application.service;

import com.fathy.alfred.backend.resend.application.port.in.ResendResolutionException;
import com.fathy.alfred.backend.resend.application.port.out.GlobalVariableLookupPort;
import com.fathy.alfred.backend.resend.application.port.out.OutgoingCall;
import com.fathy.alfred.backend.resend.application.port.out.SendOutcome;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ResendVariablesTest {
    @Test void resolvesCurrentBackendValuesInUrlHeadersAndBody() {
        var original = new StoredCall("outbound", "call-1", "POST",
                "https://supplier.test/{{path}}", Map.of("X-{{header}}", "{{value}}"),
                "before {{value}} after", "supplier.test", null);
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        var service = new ResendService(
                (direction, callId, cycleId) -> Optional.of(original),
                (direction, host, names, cycleId) -> List.of(),
                call -> { sent.set(call); return new SendOutcome.Sent(200, Map.of(), "ok"); },
                () -> new GlobalVariableLookupPort.VariableState(
                        Map.of("path", "items", "value", "{{suffix}}", "suffix", "resolved", "header", "Test"), Map.of()));
        service.resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().url()).isEqualTo("https://supplier.test/items");
        assertThat(sent.get().headers()).containsEntry("X-Test", "resolved");
        assertThat(sent.get().body()).isEqualTo("before resolved after");
    }

    private static ResendService serviceWith(Map<String, String> variables, Map<String, String> fallbacks,
            AtomicReference<OutgoingCall> sent) {
        var original = new StoredCall("outbound", "call-1", "POST", "https://supplier.test/", Map.of(),
                "{{a}}", "supplier.test", null);
        return new ResendService(
                (direction, callId, cycleId) -> Optional.of(original),
                (direction, host, names, cycleId) -> List.of(),
                call -> { sent.set(call); return new SendOutcome.Sent(200, Map.of(), "ok"); },
                () -> new GlobalVariableLookupPort.VariableState(variables, fallbacks));
    }

    @Test void selfDoublingVariableStaysBoundedInsteadOfExhaustingMemory() {
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        // The exact shape that used to double every one of the 20 fixed passes with no cycle guard.
        var service = serviceWith(Map.of("a", "{{a}}{{a}}"), Map.of(), sent);
        service.resend(new ResendRequest("outbound", "call-1", null, null, false));
        // "a" is already being resolved when its own value's "{{a}}" tokens are hit, so they stay literal.
        assertThat(sent.get().body()).isEqualTo("{{a}}{{a}}");
    }

    @Test void aToBCycleStaysVisibleInsteadOfHanging() {
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        var service = serviceWith(Map.of("a", "{{b}}", "b", "{{a}}"), Map.of(), sent);
        service.resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().body()).isEqualTo("{{a}}");
    }

    @Test void nestedResolutionResolvesFully() {
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        var service = serviceWith(Map.of("a", "{{b}}", "b", "{{c}}", "c", "final"), Map.of(), sent);
        service.resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().body()).isEqualTo("final");
    }

    @Test void unknownTokenStaysIntact() {
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        var service = serviceWith(Map.of(), Map.of(), sent);
        service.resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().body()).isEqualTo("{{a}}");
    }

    @Test void variableWinsOverFallbackOfTheSameName() {
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        var service = serviceWith(Map.of("a", "from-variable"), Map.of("a", "from-fallback"), sent);
        service.resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().body()).isEqualTo("from-variable");
    }

    @Test void oversizeResolutionThrows() {
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        String big = "x".repeat(11 * 1024 * 1024);
        var service = serviceWith(Map.of("a", big), Map.of(), sent);
        assertThatThrownBy(() -> service.resend(new ResendRequest("outbound", "call-1", null, null, false)))
                .isInstanceOf(ResendResolutionException.class);
    }
}
