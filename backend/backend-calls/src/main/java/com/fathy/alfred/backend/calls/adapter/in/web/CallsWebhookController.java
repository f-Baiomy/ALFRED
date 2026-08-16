package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.adapter.in.web.dto.CompleteCallRequestDto;
import com.fathy.alfred.backend.calls.adapter.in.web.dto.PrepareCallRequestDto;
import com.fathy.alfred.backend.calls.application.port.in.ReceiveCompletedCallUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceiveNewCallUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceivePreparedCallUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
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
 * Called by the proxy (proxy/log_and_route.py). Two-phase logging (prepare/complete) is the
 * current shape - {@code POST /calls/webhook} (the original single-shot, "log once, already
 * resolved" endpoint) stays working unchanged alongside it purely for rollout safety: it lets an
 * already-running proxy container keep logging calls if only the backend is redeployed before the
 * proxy itself is (see the two-phase logging plan) - remove once the proxy no longer calls it.
 */
@RestController
public class CallsWebhookController {

    private final ReceiveNewCallUseCase receiveNewCallUseCase;
    private final ReceivePreparedCallUseCase receivePreparedCallUseCase;
    private final ReceiveCompletedCallUseCase receiveCompletedCallUseCase;

    @Value("${alfred.webhook.secret:}")
    private String webhookSecret;

    public CallsWebhookController(
            ReceiveNewCallUseCase receiveNewCallUseCase,
            ReceivePreparedCallUseCase receivePreparedCallUseCase,
            ReceiveCompletedCallUseCase receiveCompletedCallUseCase
    ) {
        this.receiveNewCallUseCase = receiveNewCallUseCase;
        this.receivePreparedCallUseCase = receivePreparedCallUseCase;
        this.receiveCompletedCallUseCase = receiveCompletedCallUseCase;
    }

    /** @deprecated superseded by {@link #prepare}/{@link #complete} - kept only for rollout safety, see the class doc. */
    @Deprecated
    @PostMapping("/calls/webhook")
    public ResponseEntity<Void> receiveNewCall(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            @RequestBody CallRecord call
    ) {
        if (!secretMatches(providedSecret)) {
            return ResponseEntity.status(401).build();
        }
        receiveNewCallUseCase.receiveNewCall(call);
        return ResponseEntity.noContent().build();
    }

    /**
     * First half of two-phase logging - called (fire-and-forget, from the proxy's point of view)
     * the moment the proxy intercepts a request, before forwarding it upstream. The proxy already
     * generated {@code body.id()} itself and moves on without waiting for this response - the
     * returned/echoed id is only useful for manual debugging (e.g. curl). Still returns 204 if the
     * host/URL filter rejected this call, for the same reason - a later {@code complete} call for
     * this id will just 404, which the proxy already tolerates.
     */
    @PostMapping("/calls/webhook/prepare")
    public ResponseEntity<Map<String, String>> prepare(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            @RequestBody PrepareCallRequestDto body
    ) {
        if (!secretMatches(providedSecret)) {
            return ResponseEntity.status(401).build();
        }
        CallRecord partial = new CallRecord(body.id(), body.originalUrl(), body.url(), body.method(), body.request(), body.timestamp(), null, null, null);
        Optional<String> id = receivePreparedCallUseCase.receivePreparedCall(partial);
        return id.map(value -> ResponseEntity.ok(Map.of("id", value)))
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /** Second half - the upstream responded (or the proxy gave up waiting for one). 404 if {@code id} isn't a call this backend has prepared (already trimmed by retention, or never prepared at all). */
    @PostMapping("/calls/webhook/{id}/complete")
    public ResponseEntity<Void> complete(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            @PathVariable String id,
            @RequestBody CompleteCallRequestDto body
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
