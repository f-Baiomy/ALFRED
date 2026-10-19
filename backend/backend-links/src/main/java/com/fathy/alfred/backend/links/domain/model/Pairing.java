package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/** This Alfred asked another to link (D1): waiting for someone there to accept the code, then linked, or refused. */
public record Pairing(String id, String address, String peerAlfredId, String peerName, String code, String name, State state,
                      String message, Instant createdAt, String linkId) {

    public enum State {
        WAITING, LINKED, REJECTED, EXPIRED, FAILED, CANCELLED
    }

    public Pairing with(State newState, String newMessage, String newLinkId) {
        return new Pairing(id, address, peerAlfredId, peerName, code, name, newState, newMessage, createdAt, newLinkId);
    }
}
