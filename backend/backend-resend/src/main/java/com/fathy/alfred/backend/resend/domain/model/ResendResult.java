package com.fathy.alfred.backend.resend.domain.model;

import java.util.List;

public record ResendResult(String newCallId, int status, long durationMs, List<SessionValueUse> sessionValuesUsed) {
    public ResendResult {
        sessionValuesUsed = List.copyOf(sessionValuesUsed);
    }
}
