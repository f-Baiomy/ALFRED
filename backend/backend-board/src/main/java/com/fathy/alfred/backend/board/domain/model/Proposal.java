package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * Claude asking the user to take a step only the user may take: Verified, Done, or closing with a resolution. At most
 * one is open per card; the user accepts it (the step is then the user's own) or dismisses it, and either way it is
 * gone, its trace kept in the card's history.
 */
public record Proposal(String cardId, CardStatus status, Resolution resolution, String reason, String evidence, Instant at) {

    public Proposal {
        reason = reason == null ? "" : reason;
        evidence = evidence == null ? "" : evidence;
    }

    /** "VERIFIED", "DONE" or "CLOSED:FINE" - how the history records what was proposed. */
    public String target() {
        return status == CardStatus.CLOSED && resolution != null ? status.name() + ":" + resolution.name() : status.name();
    }
}
