package com.fathy.alfred.backend.internalcalls.adapter.in.web;

import com.fathy.alfred.backend.internalcalls.adapter.in.web.dto.CompleteInternalCallRequestDto;
import com.fathy.alfred.backend.internalcalls.adapter.in.web.dto.PrepareInternalCallRequestDto;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReceiveCompletedCallUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReceivePreparedCallUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.Optional;

/**
 * Called by the reverse proxy (proxy/log_and_route_reverse.py). Reuses the same shared
 * {@code alfred.webhook.secret} property backend-calls' CallsWebhookController checks - one
 * secret protects both webhooks, matching the value wildfly-proxy's compose service already
 * sends.
 */
@RestController
public class InternalCallsWebhookController {

    private final ReceivePreparedCallUseCase receivePreparedCallUseCase;
    private final ReceiveCompletedCallUseCase receiveCompletedCallUseCase;

    @Value("${alfred.webhook.secret:}")
    private String webhookSecret;

    public InternalCallsWebhookController(
            ReceivePreparedCallUseCase receivePreparedCallUseCase,
            ReceiveCompletedCallUseCase receiveCompletedCallUseCase
    ) {
        this.receivePreparedCallUseCase = receivePreparedCallUseCase;
        this.receiveCompletedCallUseCase = receiveCompletedCallUseCase;
    }

    /**
     * The moment the proxy intercepts a request, before forwarding it upstream to WildFly. The
     * proxy already generated {@code body.id()} itself and moves on without waiting for this
     * response - the returned/echoed id is only useful for manual debugging (e.g. curl).
     */
    @PostMapping("/internal-calls/webhook/prepare")
    public ResponseEntity<Map<String, String>> prepare(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            @RequestBody PrepareInternalCallRequestDto body
    ) {
        if (!secretMatches(providedSecret)) {
            return ResponseEntity.status(401).build();
        }
        CallRecord partial = new CallRecord(body.id(), body.originalUrl(), body.url(), body.method(), body.request(),
                body.timestamp(), null, null, null, null, body.sessionId(), body.operationId());
        Optional<String> id = receivePreparedCallUseCase.receivePreparedCall(partial);
        return id.map(value -> ResponseEntity.ok(Map.of("id", value)))
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /** WildFly responded (or the proxy gave up waiting for one). 404 if {@code id} isn't a call this backend has prepared (already trimmed by retention, or never prepared at all). */
    @PostMapping("/internal-calls/webhook/{id}/complete")
    public ResponseEntity<Void> complete(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            @PathVariable String id,
            @RequestBody CompleteInternalCallRequestDto body
    ) {
        if (!secretMatches(providedSecret)) {
            return ResponseEntity.status(401).build();
        }
        boolean found = receiveCompletedCallUseCase.receiveCompletedCall(id, body.response(), body.error(), body.durationMs());
        return found ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    private boolean secretMatches(String providedSecret) {
        return webhookSecret.isBlank() || webhookSecret.equals(providedSecret);
    }
}
