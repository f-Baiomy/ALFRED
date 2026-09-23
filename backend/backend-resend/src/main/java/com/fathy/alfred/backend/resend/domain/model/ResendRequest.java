package com.fathy.alfred.backend.resend.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/**
 * Represents a request to resend a previously-logged call, with optional edits to headers.
 * Resend edits are header NAMES only (not values) - per data model §7, identifies which
 * headers were changed, not what they were changed to (the actual header values come from
 * the resend request body itself).
 */
public record ResendRequest(
        String id,
        @JsonProperty("original_call_id") String originalCallId,
        String timestamp,
        /** Which headers were edited in the resend (names only, null means no headers changed). */
        @JsonProperty("edited_headers") Map<String, Boolean> editedHeaders
) {
    public ResendRequest {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("ResendRequest id cannot be blank");
        }
        if (originalCallId == null || originalCallId.isBlank()) {
            throw new IllegalArgumentException("ResendRequest originalCallId cannot be blank");
        }
    }
}
