package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.application.port.in.ReceiveNewCallUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Called by the proxy (proxy/log_and_route.py) right after it finishes writing a call to
 * calls.log - the file stays the source of truth for GET /calls, this is purely how the app
 * core learns "push that out live" without waiting for the next poll.
 */
@RestController
public class CallsWebhookController {

    private final ReceiveNewCallUseCase receiveNewCallUseCase;

    @Value("${alfred.webhook.secret:}")
    private String webhookSecret;

    public CallsWebhookController(ReceiveNewCallUseCase receiveNewCallUseCase) {
        this.receiveNewCallUseCase = receiveNewCallUseCase;
    }

    @PostMapping("/calls/webhook")
    public ResponseEntity<Void> receiveNewCall(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            @RequestBody CallRecord call
    ) {
        if (!webhookSecret.isBlank() && !webhookSecret.equals(providedSecret)) {
            return ResponseEntity.status(401).build();
        }
        receiveNewCallUseCase.receiveNewCall(call);
        return ResponseEntity.noContent().build();
    }
}
