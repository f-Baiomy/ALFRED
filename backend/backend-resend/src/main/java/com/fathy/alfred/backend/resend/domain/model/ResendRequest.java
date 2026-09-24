package com.fathy.alfred.backend.resend.domain.model;

/**
 * A request to resend a logged call through Alfred's own proxies, per contracts/rest-api.md's
 * {@code POST /resend}.
 *
 * @param direction "outbound" or "inbound" - which call slice {@code callId} was logged in.
 * @param cycleId when the call was captured into a session-cycle rather than logged live; null
 *                looks it up in the plain call log instead.
 * @param useCurrentSession substitutes the newest known session/authorization value for any the
 *                          original call carried, rather than replaying the original's own.
 * @param batch when this resend is one of several sent together; null for a single resend.
 */
public record ResendRequest(String direction, String callId, String cycleId, ResendEdits edits,
                             boolean useCurrentSession, ResendBatch batch) {

    /** A single resend - not part of any batch. */
    public ResendRequest(String direction, String callId, String cycleId, ResendEdits edits,
                         boolean useCurrentSession) {
        this(direction, callId, cycleId, edits, useCurrentSession, null);
    }
}
