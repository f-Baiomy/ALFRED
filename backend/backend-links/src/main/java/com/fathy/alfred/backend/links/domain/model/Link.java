package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/**
 * A link to another Alfred (D1-D4). The slug is what refs carry ({@code <uuid>@<slug>}) and never changes, so refs kept
 * in board texts stay valid; the name is the pill and can be renamed any time. Exactly one side dials (the one that
 * asked to link) and the other waits; both hold the same secret, used only to prove each side to the other (HMAC
 * challenge), never sent as it is and never in a response.
 */
public record Link(String id, String slug, String name, String peerAlfredId, String peerName, String address, boolean dialer,
                   String secret, Instant createdAt, Instant lastSeen, String peerVersion, Instant removedAt) {

    public boolean removed() {
        return removedAt != null;
    }

    public Link withName(String newName) {
        return new Link(id, slug, newName, peerAlfredId, peerName, address, dialer, secret, createdAt, lastSeen, peerVersion, removedAt);
    }

    public Link withPeer(String newPeerName, String newVersion, Instant seen) {
        return new Link(id, slug, name, peerAlfredId, newPeerName == null ? peerName : newPeerName,
                address, dialer, secret, createdAt, seen, newVersion == null ? peerVersion : newVersion, removedAt);
    }

    public Link withAddress(String newAddress) {
        return new Link(id, slug, name, peerAlfredId, peerName, newAddress, dialer, secret, createdAt, lastSeen, peerVersion, removedAt);
    }

    public Link removedAt(Instant at) {
        return new Link(id, slug, name, peerAlfredId, peerName, address, dialer, secret, createdAt, lastSeen, peerVersion, at);
    }

    /** A link removed earlier and made again with the same Alfred keeps its slug, so old refs work again. */
    public Link relinked(String newSecret, boolean newDialer, String newAddress, Instant at) {
        return new Link(id, slug, name, peerAlfredId, peerName, newAddress, newDialer, newSecret, at, lastSeen, peerVersion, null);
    }
}
