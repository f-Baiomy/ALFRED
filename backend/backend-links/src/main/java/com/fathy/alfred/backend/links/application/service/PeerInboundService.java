package com.fathy.alfred.backend.links.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.PeerInboundUseCase;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.ResponseWriter;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.LocalDispatchPort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.application.port.out.RemoteListenerPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Self;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Everything a linked Alfred sends: who it is, its events (handled once each, in order - D26), its signals, and its
 * reads - the peer API under /links/peer/ answered here, everything else answered from this Alfred's data by the bridge
 * (R2), which refuses whatever no stream allows.
 */
@Service
public class PeerInboundService implements PeerInboundUseCase {

    private static final Logger log = LoggerFactory.getLogger(PeerInboundService.class);

    private final LinksStorePort store;
    private final LinksService links;
    private final StreamsService streams;
    private final RequestsService requests;
    private final PresenceService presence;
    private final EnvService envs;
    private final SignalsService signals;
    private final RelayService relay;
    private final PeerTransportPort transport;
    private final LinksNotificationPort notifications;
    private final ObjectProvider<LocalDispatchPort> dispatch;
    private final ObjectProvider<RemoteListenerPort> listeners;
    private final ExecutorService background = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "link-sync");
        t.setDaemon(true);
        return t;
    });

    public PeerInboundService(LinksStorePort store, LinksService links, StreamsService streams, RequestsService requests,
                              PresenceService presence, EnvService envs, SignalsService signals, RelayService relay, PeerTransportPort transport,
                              LinksNotificationPort notifications, ObjectProvider<LocalDispatchPort> dispatch,
                              ObjectProvider<RemoteListenerPort> listeners) {
        this.store = store;
        this.links = links;
        this.streams = streams;
        this.requests = requests;
        this.presence = presence;
        this.envs = envs;
        this.signals = signals;
        this.relay = relay;
        this.transport = transport;
        this.notifications = notifications;
        this.dispatch = dispatch;
        this.listeners = listeners;
    }

    @Override
    public Self self() {
        return links.self();
    }

    @Override
    public Optional<Link> waitingLinkFor(String peerAlfredId) {
        return store.linkByPeer(peerAlfredId).filter(l -> !l.removed() && !l.dialer());
    }

    @Override
    public void online(Link link, String peerName, String peerVersion) {
        Link fresh = store.link(link.id()).orElse(link);
        store.saveLink(fresh.withPeer(peerName, peerVersion, Instant.now()));
        notifications.changed("links-changed", Json.write(Map.of("id", link.id(), "online", true)));
        // the other side's pages fetch again; this side asks for the streams it was given
        transport.signal(link.id(), "resync", "{}");
        notifications.signal(link.slug(), "resync", "{}");
        background.execute(() -> {
            try {
                BlockingResponse.Whole w = relay.fetch(link.slug(), RelayRequest.get("/links/peer/streams", ""), Duration.ofSeconds(20), 4 * 1024 * 1024);
                if (w.status() == 200) {
                    List<StreamsService.StreamEvent> list = new ArrayList<>();
                    Json.tree(w.text()).forEach(n -> list.add(Json.convert(n, StreamsService.StreamEvent.class)));
                    streams.reconcile(link, list);
                }
            } catch (RuntimeException e) {
                log.debug("Link {}: could not read its streams: {}", link.slug(), e.toString());
            }
            presence.resend(link);
        });
    }

    @Override
    public void offline(String linkId, String why) {
        presence.dropped(linkId);
        notifications.changed("links-changed", Json.write(Map.of("id", linkId, "online", false, "why", why == null ? "" : why)));
        store.link(linkId).ifPresent(l -> notifications.signal(l.slug(), "offline", Json.write(Map.of("why", why == null ? "" : why))));
    }

    @Override
    public void event(Link link, long seq, String kind, String data) {
        if (!store.received(link.id(), seq)) {
            return; // handled before this reconnect
        }
        switch (kind) {
            case "stream" -> streams.mirror(link, data, false);
            case "stream-ended" -> streams.mirror(link, data, true);
            case "request-state" -> requests.stateChanged(link, data);
            case "envs" -> envs.assigned(link, data);
            case "env-cycle" -> envs.envCycleArrived(link, data);
            default -> log.debug("Link {}: event kind {} is not known here", link.slug(), kind);
        }
    }

    @Override
    public void signal(Link link, String channel, String data) {
        switch (channel) {
            case "unlinked" -> {
                store.link(link.id()).filter(l -> !l.removed()).ifPresent(l -> {
                    envs.linkRemoved(l);
                    links.unlinkedByPeer(l);
                });
                return;
            }
            case "env" -> {
                envs.envChangedOver(link, data);
                return;
            }
            default -> {
                // below
            }
        }
        // the page matches the ids it shows, which carry the link's suffix: the signal's ids get it too
        String tagged;
        try {
            tagged = com.fathy.alfred.backend.links.domain.JsonRewriter.rewrite(data == null ? "{}" : data,
                    new com.fathy.alfred.backend.links.domain.RefTagger(link.slug()));
        } catch (RuntimeException e) {
            tagged = data;
        }
        notifications.signal(link.slug(), channel, tagged);
        listeners.orderedStream().forEach(l -> {
            try {
                l.signal(link, channel, data);
            } catch (RuntimeException e) {
                log.debug("Link {}: a listener failed on {}: {}", link.slug(), channel, e.toString());
            }
        });
        signals.passOn(link, channel, data);
    }

    @Override
    public void serve(Link link, RelayRequest r, ResponseWriter w) {
        Link current = store.link(link.id()).orElse(link);
        if (current.removed()) {
            w.error("UNLINKED", "This Alfred removed the link");
            return;
        }
        String me = links.self().alfredId();
        if (r.hops().contains(me)) {
            w.error("LOOP", "This read came back to an Alfred it already passed");
            return;
        }
        if (r.hops().size() > RelayService.MAX_HOPS) {
            w.error("TOO_FAR", "Streams pass through at most " + RelayService.MAX_HOPS + " Alfreds");
            return;
        }
        if (r.path().startsWith("/links/peer/")) {
            peerApi(current, r, w);
            return;
        }
        if (!"GET".equals(r.method())) {
            json(w, 405, problem("READ_ONLY", "A stream answers reads only - writes are requests"));
            return;
        }
        LocalDispatchPort d = dispatch.getIfAvailable();
        if (d == null) {
            json(w, 501, problem("UNSUPPORTED", "This Alfred cannot answer streamed reads"));
            return;
        }
        d.serve(current, streams.offeredTo(current.id()), r, w);
    }

    private void peerApi(Link from, RelayRequest r, ResponseWriter w) {
        String path = r.path();
        Map<String, String> q = query(r.query());
        try {
            if ("GET".equals(r.method()) && path.equals("/links/peer/streams")) {
                json(w, 200, Json.write(streams.offeredEvents(from.id())));
            } else if ("POST".equals(r.method()) && path.equals("/links/peer/requests")) {
                json(w, 200, Json.write(requests.receive(from, r.hops(), r.body() == null ? "{}" : r.body())));
            } else if ("POST".equals(r.method()) && path.startsWith("/links/peer/requests/") && path.endsWith("/withdraw")) {
                String id = path.substring("/links/peer/requests/".length(), path.length() - "/withdraw".length());
                json(w, 200, Json.write(requests.withdrawn(from, id)));
            } else if ("POST".equals(r.method()) && path.equals("/links/peer/presence")) {
                JsonNode b = Json.tree(r.body());
                String target = b.path("target").asText("");
                if (!target.isEmpty() && target.length() < 300) {
                    presence.heard(from, target, b.path("on").asBoolean(true));
                }
                json(w, 200, "{}");
            } else if ("GET".equals(r.method()) && path.equals("/links/peer/env")) {
                json(w, 200, envs.peerData(from, q.getOrDefault("board", "")));
            } else {
                json(w, 404, problem("UNSUPPORTED", "This Alfred does not know " + path));
            }
        } catch (LinksProblem p) {
            json(w, p.status(), problem(p.code(), p.getMessage()));
        } catch (LinkUnavailableException e) {
            json(w, 503, problem(e.code(), e.getMessage()));
        } catch (IllegalArgumentException e) {
            json(w, 400, problem("BAD_REQUEST", e.getMessage()));
        }
    }

    static Map<String, String> query(String query) {
        Map<String, String> out = new LinkedHashMap<>();
        if (query == null || query.isBlank()) {
            return out;
        }
        for (String part : query.split("&")) {
            int eq = part.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
            String v = eq < 0 ? "" : URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8);
            out.putIfAbsent(k, v);
        }
        return out;
    }

    private static String problem(String code, String message) {
        return Json.write(Map.of("error", code, "message", message == null ? "" : message));
    }

    private static void json(ResponseWriter w, int status, String body) {
        try {
            w.head(status, Map.of("Content-Type", "application/json"));
            w.write(body.getBytes(StandardCharsets.UTF_8));
            w.end();
        } catch (IOException e) {
            w.error("FAILED", e.getMessage());
        }
    }
}
