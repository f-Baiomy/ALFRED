package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.application.port.in.RecordResendUseCase;
import com.fathy.alfred.backend.resend.application.port.out.CallExistsPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Resend endpoints. A leaf slice's own controller - reaches the call slices only through
 * {@link CallExistsPort}, never by importing backend-calls/backend-internalcalls directly (see
 * this module's pom.xml description).
 *
 * <p>The actual resend execution happens client-side: the frontend fetches the original call,
 * optionally edits headers, then issues the resend itself with X-Alfred-Resend-Of (and
 * X-Alfred-Resend-Edits) headers pointing back at the original call id. This controller only
 * answers "can this call be resent" and records the outcome once the proxy's webhook chain
 * reports the new call.
 */
@RestController
public class ResendController {
    private static final Logger log = LoggerFactory.getLogger(ResendController.class);

    private final CallExistsPort callExistsPort;
    private final RecordResendUseCase recordResendUseCase;

    public ResendController(CallExistsPort callExistsPort, RecordResendUseCase recordResendUseCase) {
        this.callExistsPort = callExistsPort;
        this.recordResendUseCase = recordResendUseCase;
    }

    /** Lets the frontend confirm a call still exists (hasn't been trimmed/retention-swept) before opening the resend editor. */
    @GetMapping("/calls/{id}/resend")
    public ResponseEntity<Map<String, Object>> getResendMetadata(@PathVariable String id) {
        if (!callExistsPort.exists(id)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(Map.of(
                "call_id", id,
                "resend_available", true
        ));
    }

    /** Records the id linkage once a resend has actually gone out and been logged as a new call. */
    @PostMapping("/calls/resend/recorded")
    public ResponseEntity<Void> recordResendOutcome(@RequestBody Map<String, String> payload) {
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
}
