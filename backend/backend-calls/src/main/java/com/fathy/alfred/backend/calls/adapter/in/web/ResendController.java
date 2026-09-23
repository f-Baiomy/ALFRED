package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.resend.application.port.in.RecordResendUseCase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Resend endpoint: POST /calls/{id}/resend triggers a resend of a previously-logged call.
 * Returns 404 if call not found. Returns 204 on success (resend queued to proxy).
 *
 * The actual resend execution happens client-side: frontend fetches the call, modifies headers
 * if desired, then issues the resend request with X-Alfred-Resend-Of header pointing back here.
 * This controller just acknowledges receipt and records the resend intent.
 */
@RestController
public class ResendController {
    private static final Logger log = LoggerFactory.getLogger(ResendController.class);

    private final CallLogPort callLogPort;
    private final RecordResendUseCase recordResendUseCase;

    @Value("${alfred.webhook.secret:}")
    private String webhookSecret;

    public ResendController(CallLogPort callLogPort, RecordResendUseCase recordResendUseCase) {
        this.callLogPort = callLogPort;
        this.recordResendUseCase = recordResendUseCase;
    }

    /**
     * GET /calls/{id}/resend - fetch resend metadata (which headers changed, if any).
     * Used by frontend to pre-fill the resend editor.
     */
    @org.springframework.web.bind.annotation.GetMapping("/calls/{id}/resend")
    public ResponseEntity<?> getResendMetadata(@PathVariable String id) {
        Optional<CallRecord> call = callLogPort.findById(id);
        if (call.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(Map.of(
                "call_id", id,
                "resend_available", true
        ));
    }

    /**
     * POST /calls/resend/recorded - record outcome after frontend executed a resend.
     * Webhook called by proxy's complete handler when a resend call finishes.
     */
    @PostMapping("/calls/resend/recorded")
    public ResponseEntity<Void> recordResendOutcome(
            @RequestBody Map<String, String> payload) {
        String resendRequestId = payload.get("resend_request_id");
        String originalCallId = payload.get("original_call_id");
        String newCallId = payload.get("new_call_id");

        if (resendRequestId == null || originalCallId == null || newCallId == null) {
            return ResponseEntity.badRequest().build();
        }

        try {
            recordResendUseCase.recordResendOutcome(resendRequestId, originalCallId, newCallId);
        } catch (Exception e) {
            log.error("Failed to record resend outcome for {}: {}", newCallId, e.getMessage());
            return ResponseEntity.status(500).build();
        }

        return ResponseEntity.noContent().build();
    }

    private boolean secretMatches(String providedSecret) {
        return webhookSecret.isBlank() || webhookSecret.equals(providedSecret);
    }
}
