package com.fathy.alfred.backend.resend.domain.model;

import java.util.List;

/** What a resend produced - per contracts/rest-api.md's {@code 200} body. */
public record ResendResult(String newCallId, int status, long durationMs, List<SessionValueUse> sessionValuesUsed) {

    public ResendResult {
        sessionValuesUsed = sessionValuesUsed == null ? List.of() : List.copyOf(sessionValuesUsed);
    }
}
