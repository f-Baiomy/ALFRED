package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkState;
import com.fathy.alfred.backend.links.domain.model.Self;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** This Alfred and its links (D1-D4, D21, D32, D33). */
public interface LinksUseCase {

    /** A link as the page shows it: never the secret. */
    record LinkInfo(String id, String slug, String name, String peerAlfredId, String peerName, String address, boolean dialer,
                    Instant createdAt, Instant lastSeen, String peerVersion, boolean online, Long rttMs, Long clockOffsetMs,
                    boolean skewed, String lastError, Instant stateSince, int inFlight, int streamsOut, int streamsIn) {
    }

    /** What GET /links/hello answers anyone on the LAN (R4): enough to show "Smoke box · Alfred 1.52", nothing more. */
    record Hello(String alfredId, String name, String version, int streams, boolean announce) {
    }

    /** Another Alfred heard on the LAN (D33); linkedSlug when this Alfred is already linked with it. */
    record Discovered(String alfredId, String name, String address, String version, Instant seenAt, String linkedSlug) {
    }

    /** What the Settings page shows under "On this network": available false with why in Docker. */
    record Discovery(boolean available, String why, boolean announcing, List<Discovered> found) {
    }

    Self self();

    Discovery discovered();

    Self updateSelf(String name, Boolean announce);

    Hello hello();

    List<LinkInfo> links();

    Optional<Link> byId(String id);

    Optional<Link> bySlug(String slug);

    Optional<Link> byPeer(String peerAlfredId);

    LinkInfo info(Link link);

    LinkState state(String linkId);

    LinkInfo rename(String id, String name);

    /** Removes the link on both sides (the other Alfred is told when it is online, or on its next connect). */
    void unlink(String id);

    /** Changes the address a dialing link uses (the other Alfred moved). */
    LinkInfo readdress(String id, String address);
}
