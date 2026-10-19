package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/**
 * A link's health right now (D21, D32): online or not, the round trip, the other clock's offset, and the last error. Kept
 * in memory by the connection; offline is a state, never an error page.
 */
public record LinkState(String linkId, boolean online, Long rttMs, Long clockOffsetMs, String lastError, Instant since, int inFlight) {

    public static LinkState offline(String linkId, String why, Instant since) {
        return new LinkState(linkId, false, null, null, why, since, 0);
    }

    /** A skew this large is shown on the link, since re-test windows compare times on both Alfreds. */
    public boolean skewed() {
        return clockOffsetMs != null && Math.abs(clockOffsetMs) > 120_000;
    }
}
