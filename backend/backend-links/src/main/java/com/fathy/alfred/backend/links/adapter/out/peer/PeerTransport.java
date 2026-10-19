package com.fathy.alfred.backend.links.adapter.out.peer;

import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.PeerInboundUseCase;
import com.fathy.alfred.backend.links.application.port.in.RelayCall;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.ResponseSink;
import com.fathy.alfred.backend.links.application.port.in.ResponseWriter;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkState;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.net.http.HttpClient;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Every link's connection (D3). The dialing side keeps one open (reconnecting with a growing pause, never faster than
 * once a second); the waiting side takes the one the other dials. A heartbeat every {@link #PING_SECONDS} keeps the
 * round trip and the clock offset current (D32) and finds a dead connection - it is a keep-alive, not a poll of data.
 */
@Component
public class PeerTransport implements PeerTransportPort {

    private static final Logger log = LoggerFactory.getLogger(PeerTransport.class);

    static final long PING_SECONDS = 25;
    static final long DEAD_AFTER_MS = 90_000;

    private final ObjectProvider<PeerInboundUseCase> inbound;
    private final LinksStorePort store;
    private final Map<String, PeerChannel> channels = new ConcurrentHashMap<>();
    private final Map<String, PeerDialer> dialers = new ConcurrentHashMap<>();
    private final Map<String, LinkState> lastOffline = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "link-serve");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2, r -> {
        Thread t = new Thread(r, "link-heartbeat");
        t.setDaemon(true);
        return t;
    });
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();

    public PeerTransport(ObjectProvider<PeerInboundUseCase> inbound, LinksStorePort store) {
        this.inbound = inbound;
        this.store = store;
        scheduler.scheduleWithFixedDelay(this::heartbeat, PING_SECONDS, PING_SECONDS, TimeUnit.SECONDS);
    }

    @PreDestroy
    public void stop() {
        dialers.values().forEach(PeerDialer::stop);
        channels.values().forEach(c -> c.close("Alfred is stopping"));
        scheduler.shutdownNow();
        pool.shutdownNow();
    }

    ExecutorService pool() {
        return pool;
    }

    ScheduledExecutorService scheduler() {
        return scheduler;
    }

    HttpClient http() {
        return http;
    }

    PeerInboundUseCase inbound() {
        return inbound.getObject();
    }

    // ------------------------------------------------------------------------------------------------------ the port

    @Override
    public void connect(Link link) {
        if (!link.dialer() || link.removed() || link.address() == null || link.address().isBlank()) {
            return;
        }
        PeerDialer existing = dialers.get(link.id());
        if (existing != null) {
            if (existing.sameAs(link)) {
                existing.wake();
                return;
            }
            existing.stop();
            PeerChannel c = channels.get(link.id());
            if (c != null) {
                closed(c, "The link changed");
            }
        }
        PeerDialer d = new PeerDialer(link, this);
        dialers.put(link.id(), d);
        d.start();
    }

    @Override
    public void drop(String linkId, String why) {
        PeerDialer d = dialers.remove(linkId);
        if (d != null) {
            d.stop();
        }
        PeerChannel c = channels.get(linkId);
        if (c != null) {
            try {
                c.send(Frames.frame("bye").put("why", why));
            } catch (RuntimeException ignored) {
                // already gone
            }
            closed(c, why);
        }
    }

    @Override
    public LinkState state(String linkId) {
        PeerChannel c = channels.get(linkId);
        if (c != null && !c.closed()) {
            return new LinkState(linkId, true, c.rttMs(), c.offsetMs(), null, c.since(), c.inFlight());
        }
        return lastOffline.getOrDefault(linkId, LinkState.offline(linkId, "Not connected yet", null));
    }

    @Override
    public RelayCall request(String linkId, RelayRequest request, ResponseSink sink) {
        PeerChannel c = channels.get(linkId);
        if (c == null || c.closed()) {
            LinkState s = state(linkId);
            throw new LinkUnavailableException("OFFLINE", null, s.lastError() == null ? "Offline" : s.lastError());
        }
        return c.request(request, sink);
    }

    @Override
    public void flush(String linkId) {
        PeerChannel c = channels.get(linkId);
        if (c == null || c.closed()) {
            return;
        }
        synchronized (c) {
            long from = c.sentUpTo();
            for (LinksStorePort.OutboxEvent e : store.outbox(linkId)) {
                if (e.seq() <= from) {
                    continue;
                }
                try {
                    c.event(e.seq(), e.kind(), e.data());
                    c.sentUpTo(e.seq());
                } catch (RuntimeException ex) {
                    return; // sent again on the next connect
                }
            }
        }
    }

    @Override
    public void signal(String linkId, String channel, String data) {
        PeerChannel c = channels.get(linkId);
        if (c != null && !c.closed()) {
            c.signal(channel, data);
        }
    }

    // ------------------------------------------------------------------------------------------- from the channels

    /** A connection proved itself (either side): it replaces any older one of the same link. */
    PeerChannel attach(Link link, Wire wire, String peerName, String peerVersion) {
        PeerChannel channel = new PeerChannel(link, wire, this, peerName, peerVersion);
        PeerChannel old = channels.put(link.id(), channel);
        if (old != null && old != channel) {
            old.close("Replaced by a new connection");
        }
        lastOffline.remove(link.id());
        pool.execute(() -> {
            try {
                inbound().online(link, peerName, peerVersion);
            } catch (RuntimeException e) {
                log.warn("Link {}: online handling failed: {}", link.slug(), e.toString());
            }
            flush(link.id());
        });
        return channel;
    }

    /** A connection ended. Only the current one of a link reports the link offline. */
    void closed(PeerChannel channel, String why) {
        channel.close(why);
        if (channels.remove(channel.link().id(), channel)) {
            lastOffline.put(channel.link().id(), LinkState.offline(channel.link().id(), why, Instant.now()));
            pool.execute(() -> {
                try {
                    inbound().offline(channel.link().id(), why);
                } catch (RuntimeException e) {
                    log.warn("Link {}: offline handling failed: {}", channel.link().slug(), e.toString());
                }
            });
            PeerDialer d = dialers.get(channel.link().id());
            if (d != null) {
                d.lost();
            }
        }
    }

    /** A dial failed before any connection: the reason is shown on the link. */
    void failed(Link link, String why) {
        LinkState prev = lastOffline.get(link.id());
        if (prev == null || prev.lastError() == null || !prev.lastError().equals(why)) {
            lastOffline.put(link.id(), LinkState.offline(link.id(), why, Instant.now()));
            pool.execute(() -> {
                try {
                    inbound().offline(link.id(), why);
                } catch (RuntimeException e) {
                    log.debug("Link {}: offline handling failed: {}", link.slug(), e.toString());
                }
            });
        }
    }

    void event(PeerChannel c, long seq, String kind, String data) {
        inbound().event(c.link(), seq, kind, data);
    }

    void acked(PeerChannel c, long seq) {
        store.acked(c.link().id(), seq);
    }

    void signal(PeerChannel c, String channel, String data) {
        inbound().signal(c.link(), channel, data);
    }

    void serve(PeerChannel c, RelayRequest r, ResponseWriter w) {
        inbound().serve(c.link(), r, w);
    }

    private void heartbeat() {
        long now = System.currentTimeMillis();
        for (PeerChannel c : channels.values()) {
            if (c.closed()) {
                continue;
            }
            if (now - c.lastHeard() > DEAD_AFTER_MS) {
                log.info("Link {}: nothing heard for {} s - closing", c.link().slug(), (now - c.lastHeard()) / 1000);
                closed(c, "Nothing heard from " + c.link().name() + " for over a minute");
                continue;
            }
            if (c.link().dialer()) {
                c.ping();
            }
        }
    }
}
