package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * Claude asking the user to take a step only the user may take: Verified, Done, or closing with a resolution. At most
 * one is open per card; the user accepts it (the step is then the user's own) or dismisses it, and either way it is
 * gone, its trace kept in the card's history.
 */
public record Proposal(String cardId, CardStatus status, Resolution resolution, String reason, String evidence, Instant at,
                       Kind kind, String intoCardId, Integer intoNumber) {

    /** A status step (Verified, Done, close), merging this card into another, or reopening a finished one (a regression). */
    public enum Kind { STATUS, MERGE, REOPEN }

    public Proposal {
        reason = reason == null ? "" : reason;
        evidence = evidence == null ? "" : evidence;
        kind = kind == null ? Kind.STATUS : kind;
    }

    public Proposal(String cardId, CardStatus status, Resolution resolution, String reason, String evidence, Instant at) {
        this(cardId, status, resolution, reason, evidence, at, Kind.STATUS, null, null);
    }

    /** "VERIFIED", "DONE", "CLOSED:FINE", "MERGE:#11" or "REOPEN" - how the history records what was proposed. */
    public String target() {
        return switch (kind) {
            case MERGE -> "MERGE:#" + intoNumber;
            case REOPEN -> "REOPEN";
            case STATUS -> status == CardStatus.CLOSED && resolution != null ? status.name() + ":" + resolution.name() : status.name();
        };
    }
}
