package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Self;

import java.util.Optional;

/** What the connection hands the application: who is on the other end, and what it sent. */
public interface PeerInboundUseCase {

    Self self();

    /** The link a connecting Alfred claims to be, if this Alfred has it (and is the waiting side of it). */
    Optional<Link> waitingLinkFor(String peerAlfredId);

    void online(Link link, String peerName, String peerVersion);

    void offline(String linkId, String why);

    /** A durable event (in order, at least once - so handled idempotently by its sequence number). */
    void event(Link link, long seq, String kind, String data);

    /** A signal: something changed over there (not kept, not repeated). */
    void signal(Link link, String channel, String data);

    /** A read (or a peer-API call) to answer. Runs on a worker thread; may block while it writes. */
    void serve(Link link, RelayRequest request, ResponseWriter writer);
}
