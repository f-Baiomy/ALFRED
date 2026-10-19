package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.out.DiscoveryPort;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkState;
import com.fathy.alfred.backend.links.domain.model.Self;
import com.fathy.alfred.backend.links.domain.model.Stream;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.net.InetAddress;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** This Alfred's identity and its links (D1-D4, D32, D33). */
@Service
public class LinksService implements LinksUseCase {

    static final String KEY_ID = "alfred.id";
    static final String KEY_NAME = "alfred.name";
    static final String KEY_ANNOUNCE = "alfred.announce";
    /** The streams protocol this Alfred speaks (R4). */
    static final int STREAMS_VERSION = 1;

    private final LinksStorePort store;
    private final PeerTransportPort transport;
    private final LinksNotificationPort notifications;
    private final DiscoveryPort discovery;
    private final Clock clock;
    private final String version;
    private final String defaultName;

    @Autowired
    public LinksService(LinksStorePort store, PeerTransportPort transport, LinksNotificationPort notifications, DiscoveryPort discovery,
                        @Value("${ALFRED_VERSION:}") String version, @Value("${ALFRED_NAME:}") String configuredName,
                        @Value("${ALFRED_RUNTIME:docker}") String runtime) {
        this(store, transport, notifications, discovery, Clock.systemUTC(), version, defaultName(configuredName, runtime));
    }

    LinksService(LinksStorePort store, PeerTransportPort transport, LinksNotificationPort notifications, DiscoveryPort discovery,
                 Clock clock, String version, String defaultName) {
        this.store = store;
        this.transport = transport;
        this.notifications = notifications;
        this.discovery = discovery;
        this.clock = clock;
        this.version = version == null || version.isBlank() ? "dev" : version;
        this.defaultName = defaultName;
    }

    static String defaultName(String configured, String runtime) {
        if (configured != null && !configured.isBlank()) {
            return configured.trim();
        }
        if ("native".equals(runtime)) {
            try {
                String host = InetAddress.getLocalHost().getHostName();
                if (host != null && !host.isBlank()) {
                    return host;
                }
            } catch (Exception ignored) {
                // no name - the default below
            }
        }
        return "Alfred";
    }

    /**
     * Dials every link this side dials, once the app is up (the other Alfreds may already be waiting), and tells the LAN
     * announcer who this Alfred is.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void dialAll() {
        for (Link l : store.links(false)) {
            transport.connect(l);
        }
        discovery.announce(self());
    }

    @Override
    public Discovery discovered() {
        Self me = self();
        // a supervisor that restarted on its own has forgotten who this Alfred is: saying it again is cheap
        discovery.announce(me);
        DiscoveryPort.Heard heard = discovery.heard();
        Map<String, String> linked = new java.util.HashMap<>();
        for (Link l : store.links(false)) {
            if (l.peerAlfredId() != null) {
                linked.put(l.peerAlfredId(), l.slug());
            }
        }
        List<Discovered> found = heard.found().stream()
                .filter(f -> !f.alfredId().equals(me.alfredId()))
                .map(f -> new Discovered(f.alfredId(), f.name(), f.address(), f.version(), f.seenAt(), linked.get(f.alfredId())))
                .toList();
        return new Discovery(heard.available(), heard.why(), me.announce(), found);
    }

    @Override
    public synchronized Self self() {
        String id = store.setting(KEY_ID).orElse(null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            store.setting(KEY_ID, id);
        }
        String name = store.setting(KEY_NAME).orElse(defaultName);
        boolean announce = store.setting(KEY_ANNOUNCE).map(Boolean::parseBoolean).orElse(true);
        return new Self(id, name, announce, version);
    }

    @Override
    public Self updateSelf(String name, Boolean announce) {
        if (name != null) {
            String n = name.trim();
            if (n.isEmpty() || n.length() > 60) {
                throw LinksProblem.bad("A name of 1 to 60 characters");
            }
            store.setting(KEY_NAME, n);
        }
        if (announce != null) {
            store.setting(KEY_ANNOUNCE, Boolean.toString(announce));
        }
        Self s = self();
        discovery.announce(s);
        notifications.changed("self-changed", Json.write(s));
        return s;
    }

    @Override
    public Hello hello() {
        Self s = self();
        return new Hello(s.alfredId(), s.name(), s.version(), STREAMS_VERSION, s.announce());
    }

    @Override
    public List<LinkInfo> links() {
        List<Stream> streams = store.streams();
        return store.links(false).stream().map(l -> info(l, streams)).toList();
    }

    @Override
    public Optional<Link> byId(String id) {
        return store.link(id);
    }

    @Override
    public Optional<Link> bySlug(String slug) {
        return store.linkBySlug(slug);
    }

    @Override
    public Optional<Link> byPeer(String peerAlfredId) {
        return store.linkByPeer(peerAlfredId);
    }

    @Override
    public LinkInfo info(Link link) {
        return info(link, store.streams());
    }

    private LinkInfo info(Link l, List<Stream> streams) {
        LinkState s = transport.state(l.id());
        int out = (int) streams.stream().filter(x -> x.mine() && x.active() && x.linkId().equals(l.id())).count();
        int in = (int) streams.stream().filter(x -> !x.mine() && x.active() && x.linkId().equals(l.id())).count();
        return new LinkInfo(l.id(), l.slug(), l.name(), l.peerAlfredId(), l.peerName(), l.address(), l.dialer(), l.createdAt(), l.lastSeen(),
                l.peerVersion(), s.online(), s.rttMs(), s.clockOffsetMs(), s.skewed(), s.lastError(), s.since(), s.inFlight(), out, in);
    }

    @Override
    public LinkState state(String linkId) {
        return transport.state(linkId);
    }

    private Link live(String id) {
        Link l = store.link(id).orElseThrow(() -> LinksProblem.notFound("That link"));
        if (l.removed()) {
            throw LinksProblem.notFound("That link");
        }
        return l;
    }

    @Override
    public LinkInfo rename(String id, String name) {
        Link l = live(id);
        String n = name == null ? "" : name.trim();
        if (n.isEmpty() || n.length() > 40) {
            throw LinksProblem.bad("A name of 1 to 40 characters");
        }
        Link renamed = l.withName(n);
        store.saveLink(renamed);
        notifications.changed("links-changed", Json.write(Map.of("id", id)));
        return info(renamed);
    }

    @Override
    public void unlink(String id) {
        Link l = live(id);
        Instant now = clock.instant();
        // the other side is told now when it is online; otherwise it learns on its next connect (it is refused)
        transport.signal(l.id(), "unlinked", "{}");
        transport.drop(l.id(), "Unlinked");
        endStreams(l.id(), now);
        store.saveLink(l.removedAt(now));
        store.clearEvents(l.id());
        notifications.changed("links-changed", Json.write(Map.of("id", id)));
        notifications.changed("streams-changed", "{}");
    }

    /** The other Alfred removed the link: the same as removing it here, without telling it back. */
    void unlinkedByPeer(Link l) {
        Instant now = clock.instant();
        transport.drop(l.id(), "The other Alfred removed the link");
        endStreams(l.id(), now);
        store.saveLink(l.removedAt(now));
        store.clearEvents(l.id());
        notifications.changed("links-changed", Json.write(Map.of("id", l.id())));
        notifications.changed("streams-changed", "{}");
    }

    private void endStreams(String linkId, Instant now) {
        for (Stream s : store.streams()) {
            if (s.linkId().equals(linkId) && s.active()) {
                store.saveStream(s.ended(now));
            }
        }
    }

    @Override
    public LinkInfo readdress(String id, String address) {
        Link l = live(id);
        if (!l.dialer()) {
            throw LinksProblem.bad("The other Alfred dials this link - change the address there");
        }
        String a = address == null ? "" : address.trim();
        if (a.isEmpty()) {
            throw LinksProblem.bad("An address like 192.168.1.83:3000");
        }
        Link moved = l.withAddress(a);
        store.saveLink(moved);
        transport.connect(moved);
        notifications.changed("links-changed", Json.write(Map.of("id", id)));
        return info(moved);
    }
}
