package com.fathy.alfred.backend.resend.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result of executing a ResendRequest - the new call that was logged as a result of
 * the resend, linked back to the original call via resend_of field.
 */
public record ResendOutcome(
        String id,
        /** The new call ID assigned after the resend was executed. */
        @JsonProperty("new_call_id") String newCallId,
        @JsonProperty("resend_request_id") String resendRequestId,
        @JsonProperty("original_call_id") String originalCallId,
        String timestamp
) {
    public ResendOutcome {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("ResendOutcome id cannot be blank");
        }
        if (newCallId == null || newCallId.isBlank()) {
            throw new IllegalArgumentException("ResendOutcome newCallId cannot be blank");
        }
        if (originalCallId == null || originalCallId.isBlank()) {
            throw new IllegalArgumentException("ResendOutcome originalCallId cannot be blank");
        }
    }
}
