package com.fathy.alfred.backend.resend.domain.model;

public record ResendRequest(String direction, String callId, String cycleId, ResendEdits edits,
                             boolean useCurrentSession) {
    public ResendRequest {
        edits = edits == null ? ResendEdits.NONE : edits;
    }
}
