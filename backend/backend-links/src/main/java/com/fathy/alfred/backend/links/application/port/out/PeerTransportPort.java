package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.application.port.in.RelayCall;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.ResponseSink;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkState;

/** The one connection per link (D3): dialed by the side that asked to link, kept open, multiplexed. */
public interface PeerTransportPort {

    /** Dials (and keeps dialing) a link this side dials; a waiting side does nothing until the other connects. */
    void connect(Link link);

    /** Closes a link's connection and stops dialing it. */
    void drop(String linkId, String why);

    LinkState state(String linkId);

    /** Sends a read; throws {@link com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException} when offline. */
    RelayCall request(String linkId, RelayRequest request, ResponseSink sink);

    /** Sends any events waiting in the link's outbox (called after one is added and on every connect). */
    void flush(String linkId);

    /** A signal for the other side: sent now if online, dropped if not (a reconnect sends "resync"). */
    void signal(String linkId, String channel, String data);
}
