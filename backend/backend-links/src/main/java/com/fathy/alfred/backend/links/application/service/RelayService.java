package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.RelayCall;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import com.fathy.alfred.backend.links.application.port.in.ResponseSink;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/** Sends reads over a link (R1-R3, R6): adds this Alfred to the hops so the far side can refuse a loop or a fourth hop. */
@Service
public class RelayService implements RelayUseCase {

    /** At most this many Alfreds stand before the one answering (D8: "at most 3 hops"). */
    static final int MAX_HOPS = 3;

    private final LinksStorePort store;
    private final PeerTransportPort transport;
    private final LinksService links;

    public RelayService(LinksStorePort store, PeerTransportPort transport, LinksService links) {
        this.store = store;
        this.transport = transport;
        this.links = links;
    }

    private Link link(String slug) {
        Link l = store.linkBySlug(slug).orElseThrow(() -> new LinkUnavailableException("UNKNOWN_LINK", slug,
                "This Alfred has no link called " + slug));
        if (l.removed()) {
            throw new LinkUnavailableException("UNLINKED", slug, l.name() + " is no longer linked");
        }
        return l;
    }

    @Override
    public RelayCall open(String slug, RelayRequest request, ResponseSink sink) {
        Link l = link(slug);
        List<String> hops = new ArrayList<>(request.hops());
        String me = links.self().alfredId();
        if (hops.contains(me)) {
            throw new LinkUnavailableException("LOOP", slug, "This read came back to the Alfred it started from");
        }
        hops.add(me);
        if (hops.size() > MAX_HOPS) {
            throw new LinkUnavailableException("TOO_FAR", slug, "Streams pass through at most " + MAX_HOPS + " Alfreds");
        }
        try {
            return transport.request(l.id(), request.withHops(hops), sink);
        } catch (LinkUnavailableException e) {
            throw new LinkUnavailableException(e.code(), slug, l.name() + " is offline" + (e.getMessage() == null ? "" : " - " + e.getMessage()));
        }
    }

    @Override
    public BlockingResponse.Whole fetch(String slug, RelayRequest request, Duration wait, int maxBytes) {
        BlockingResponse response = new BlockingResponse();
        RelayCall call = open(slug, request, response);
        response.attach(call);
        try {
            return response.readWhole(wait, maxBytes);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            call.cancel();
            throw new LinkUnavailableException("TIMEOUT", slug, "Interrupted");
        } catch (LinkUnavailableException e) {
            throw new LinkUnavailableException(e.code(), slug, e.getMessage());
        }
    }

    @Override
    public boolean knows(String slug) {
        return slug != null && store.linkBySlug(slug).isPresent();
    }

    @Override
    public boolean online(String slug) {
        return store.linkBySlug(slug).filter(l -> !l.removed()).map(l -> transport.state(l.id()).online()).orElse(false);
    }
}
