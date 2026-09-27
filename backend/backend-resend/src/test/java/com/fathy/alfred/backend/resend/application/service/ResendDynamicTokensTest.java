package com.fathy.alfred.backend.resend.application.service;

import com.fathy.alfred.backend.resend.application.port.out.CallSenderPort;
import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.application.port.out.GlobalVariableLookupPort;
import com.fathy.alfred.backend.resend.application.port.out.OutgoingCall;
import com.fathy.alfred.backend.resend.application.port.out.SendOutcome;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * D4 dynamic tokens resolved by the resend backend, AFTER global variables (contracts.md section
 * 2). The exhaustive grammar corpus lives in {@code DynamicTokensVectorTest} - this only checks
 * that {@code ResendService} actually wires {@link com.fathy.alfred.backend.resend.domain.model.DynamicTokens}
 * into method/URL/headers/body, in the right order relative to {{name}} variable resolution.
 */
class ResendDynamicTokensTest {

    private static final Instant NOW = Instant.parse("2026-09-27T16:04:05.123Z");

    private ResendService serviceWith(StoredCall original, Map<String, String> variables, AtomicReference<OutgoingCall> sent) {
        return new ResendService(
                (direction, callId, cycleId) -> Optional.of(original),
                (direction, host, names, cycleId) -> java.util.List.of(),
                call -> { sent.set(call); return new SendOutcome.Sent(200, Map.of(), "ok"); },
                () -> new GlobalVariableLookupPort.VariableState(variables, Map.of()),
                Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @Test void nowTokenResolvesInUrlAndBody() {
        var original = new StoredCall("outbound", "call-1", "GET",
                "https://supplier.test/{{$now:yyyy-MM-dd}}", Map.of(), "at {{$now}}", "supplier.test", null);
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        serviceWith(original, Map.of(), sent).resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().url()).isEqualTo("https://supplier.test/2026-09-27");
        assertThat(sent.get().body()).isEqualTo("at 2026-09-27T16:04:05.123Z");
    }

    @Test void dynamicTokensResolveAfterGlobalVariables() {
        // The variable's own value contains a dynamic token - it must still resolve, proving
        // dynamic-token resolution runs on the result of variable resolution, not before it.
        var original = new StoredCall("outbound", "call-1", "GET",
                "https://supplier.test/", Map.of(), "{{path}}", "supplier.test", null);
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        serviceWith(original, Map.of("path", "id-{{$uuid}}"), sent)
                .resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().body()).matches(Pattern.compile(
                "^id-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"));
    }

    @Test void base64TokenUsesGlobalVariables() {
        var original = new StoredCall("outbound", "call-1", "GET",
                "https://supplier.test/", Map.of("Authorization", "Basic {{$base64:creds}}"), null, "supplier.test", null);
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        serviceWith(original, Map.of("creds", "user:pass"), sent)
                .resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().headers()).containsEntry("Authorization", "Basic dXNlcjpwYXNz");
    }

    @Test void thisAndRowTokensStayLiteral() {
        // {{this.x}}/{{row.x}} are frontend-substituted before the request ever reaches the
        // backend (contracts.md section 2) - the backend must never touch them.
        var original = new StoredCall("outbound", "call-1", "GET",
                "https://supplier.test/", Map.of(), "{{this.token}} {{row.id}}", "supplier.test", null);
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        serviceWith(original, Map.of(), sent).resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().body()).isEqualTo("{{this.token}} {{row.id}}");
    }

    @Test void unknownDynamicTokenStaysLiteral() {
        var original = new StoredCall("outbound", "call-1", "GET",
                "https://supplier.test/", Map.of(), "{{$unknown}}", "supplier.test", null);
        AtomicReference<OutgoingCall> sent = new AtomicReference<>();
        serviceWith(original, Map.of(), sent).resend(new ResendRequest("outbound", "call-1", null, null, false));
        assertThat(sent.get().body()).isEqualTo("{{$unknown}}");
    }
}
