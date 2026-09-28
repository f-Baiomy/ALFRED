package com.fathy.alfred.backend.resend.domain.model;

/** A request to resend a logged call through Alfred's own proxies. */
public record ResendRequest(String direction, String callId, String cycleId, ResendEdits edits,
                            boolean useCurrentSession, ResendBatch batch, ReliveResendTarget relive) {
    public ResendRequest(String direction, String callId, String cycleId, ResendEdits edits, boolean useCurrentSession) {
        this(direction, callId, cycleId, edits, useCurrentSession, null, null);
    }

    public ResendRequest(String direction, String callId, String cycleId, ResendEdits edits, boolean useCurrentSession, ResendBatch batch) {
        this(direction, callId, cycleId, edits, useCurrentSession, batch, null);
    }
}
