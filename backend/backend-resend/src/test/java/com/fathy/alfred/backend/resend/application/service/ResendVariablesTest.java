package com.fathy.alfred.backend.resend.application.service;

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

class ResendVariablesTest {
    @Test void resolvesCurrentBackendValuesInUrlHeadersAndBody() {
        var original = new StoredCall("outbound", "call-1", "POST",
                "https://supplier.test/{{path}}", Map.of("X-{{header}}", "{{value}}"),
                "before {{value}} after", "supplier.test", null);
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        var service = new ResendService(
                (direction, callId, cycleId) -> Optional.of(original),
                (direction, host, names, cycleId) -> List.of(),
                call -> { sent.set(call); return new SendOutcome.Sent(200, "ok"); },
                () -> new GlobalVariableLookupPort.VariableState(
                        Map.of("path", "items", "value", "{{suffix}}", "suffix", "resolved", "header", "Test"), Map.of()));
        service.resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().url()).isEqualTo("https://supplier.test/items");
        assertThat(sent.get().headers()).containsEntry("X-Test", "resolved");
        assertThat(sent.get().body()).isEqualTo("before resolved after");
    }
}
