package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/**
 * Another Alfred asked to link with this one (D1). Shown with its one-time code to whoever has this Alfred open; any user
 * accepts. Lives ten minutes in memory, never in links.db.
 */
public record Offer(String id, String code, String fromAlfredId, String fromName, String fromAddress, String fromVersion,
                    Instant createdAt, Instant expiresAt, State state, String linkId) {

    public enum State {
        WAITING, ACCEPTED, REJECTED, EXPIRED, COLLECTED
    }

    public Offer with(State newState, String newLinkId) {
        return new Offer(id, code, fromAlfredId, fromName, fromAddress, fromVersion, createdAt, expiresAt, newState, newLinkId);
    }
}
