package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.in.PairingUseCase;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerHttpPort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.domain.Mac;
import com.fathy.alfred.backend.links.domain.Slugs;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Offer;
import com.fathy.alfred.backend.links.domain.model.Pairing;
import com.fathy.alfred.backend.links.domain.model.Self;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Linking with a one-time code (D1). An offer lives ten minutes in memory; the secret it ends with is handed once, to
 * the Alfred that made the offer (it alone knows the nonce), and from then on is used only for the link's proof.
 */
@Service
public class PairingService implements PairingUseCase {

    private static final Logger log = LoggerFactory.getLogger(PairingService.class);

    static final Duration OFFER_LIFE = Duration.ofMinutes(10);
    static final Duration WAIT = Duration.ofSeconds(55);
    static final int MAX_WAITING_OFFERS = 10;

    private record Held(Offer offer, String nonce, List<CompletableFuture<OfferResult>> waiters, String secret) {
    }

    private final LinksStorePort store;
    private final LinksService links;
    private final PeerHttpPort http;
    private final PeerTransportPort transport;
    private final LinksNotificationPort notifications;
    private final Clock clock;
    private final Map<String, Held> offers = new ConcurrentHashMap<>();
    private final Map<String, Pairing> pairings = new ConcurrentHashMap<>();
    private final ExecutorService waiters = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "link-pairing");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "link-pairing-timer");
        t.setDaemon(true);
        return t;
    });

    @org.springframework.beans.factory.annotation.Autowired
    public PairingService(LinksStorePort store, LinksService links, PeerHttpPort http, PeerTransportPort transport,
                          LinksNotificationPort notifications) {
        this(store, links, http, transport, notifications, Clock.systemUTC());
    }

    PairingService(LinksStorePort store, LinksService links, PeerHttpPort http, PeerTransportPort transport, LinksNotificationPort notifications,
                   Clock clock) {
        this.store = store;
        this.links = links;
        this.http = http;
        this.transport = transport;
        this.notifications = notifications;
        this.clock = clock;
    }

    @PreDestroy
    void stop() {
        waiters.shutdownNow();
        timer.shutdownNow();
    }

    static String normalize(String address) {
        String a = address == null ? "" : address.trim();
        while (a.endsWith("/")) {
            a = a.substring(0, a.length() - 1);
        }
        if (a.isEmpty()) {
            throw LinksProblem.bad("An address like 192.168.1.83:3000");
        }
        if (!a.startsWith("http://") && !a.startsWith("https://")) {
            a = "http://" + a;
        }
        return a;
    }

    // ---------------------------------------------------------------------------------------------- the asking side

    @Override
    public Pairing start(String address, String name) {
        String base = normalize(address);
        Self self = links.self();
        LinksUseCase.Hello hello;
        try {
            hello = http.hello(base);
        } catch (LinkUnavailableException e) {
            throw new LinksProblem(e.code(), 502, e.getMessage());
        }
        if (hello.alfredId().equals(self.alfredId())) {
            throw LinksProblem.bad("That address is this Alfred");
        }
        Optional<Link> existing = store.linkByPeer(hello.alfredId()).filter(l -> !l.removed());
        if (existing.isPresent()) {
            throw LinksProblem.conflict("ALREADY_LINKED", "This Alfred is already linked with " + existing.get().name());
        }
        String nonce = Mac.random(24);
        OfferAnswer answer;
        try {
            answer = http.offer(base, new OfferIn(self.alfredId(), self.name(), self.version(), nonce, null));
        } catch (LinkUnavailableException e) {
            throw new LinksProblem(e.code(), 502, e.getMessage());
        }
        String n = name == null || name.isBlank() ? (hello.name().isBlank() ? "Alfred" : hello.name()) : name.trim();
        Pairing p = new Pairing(UUID.randomUUID().toString(), base, hello.alfredId(), hello.name(), answer.code(), n, Pairing.State.WAITING,
                "Waiting for someone on " + (hello.name().isBlank() ? base : hello.name()) + " to accept code " + answer.code(),
                clock.instant(), null);
        pairings.put(p.id(), p);
        notifications.changed("pairings-changed", Json.write(p));
        waiters.execute(() -> waitFor(p.id(), base, answer.offerId(), nonce));
        return p;
    }

    private void waitFor(String pairingId, String base, String offerId, String nonce) {
        Instant until = clock.instant().plus(OFFER_LIFE).plusSeconds(30);
        while (clock.instant().isBefore(until)) {
            Pairing p = pairings.get(pairingId);
            if (p == null || p.state() != Pairing.State.WAITING) {
                return;
            }
            OfferResult r;
            try {
                r = http.await(base, offerId, nonce);
            } catch (LinkUnavailableException e) {
                if ("OFFLINE".equals(e.code())) {
                    sleep(5);
                    continue;
                }
                finish(pairingId, Pairing.State.FAILED, e.getMessage(), null);
                return;
            } catch (RuntimeException e) {
                sleep(5);
                continue;
            }
            switch (r.state()) {
                case "ACCEPTED" -> {
                    if (r.secret() == null) {
                        finish(pairingId, Pairing.State.FAILED, "The other Alfred accepted, but the link could not be set up - try again", null);
                        return;
                    }
                    Link link = linkAsDialer(p, base, r);
                    finish(pairingId, Pairing.State.LINKED, "Linked with " + link.name(), link.id());
                    return;
                }
                case "REJECTED" -> {
                    finish(pairingId, Pairing.State.REJECTED, "Refused on " + p.peerName(), null);
                    return;
                }
                case "EXPIRED", "COLLECTED" -> {
                    finish(pairingId, Pairing.State.EXPIRED, "The code expired before anyone accepted it", null);
                    return;
                }
                default -> {
                    // still waiting: ask again
                }
            }
        }
        finish(pairingId, Pairing.State.EXPIRED, "The code expired before anyone accepted it", null);
    }

    private static void sleep(int seconds) {
        try {
            Thread.sleep(seconds * 1000L);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private synchronized Link linkAsDialer(Pairing p, String base, OfferResult r) {
        Instant now = clock.instant();
        Optional<Link> before = store.linkByPeer(p.peerAlfredId());
        Link link;
        if (before.isPresent()) {
            link = before.get().relinked(r.secret(), true, base, now).withName(p.name()).withPeer(r.name(), r.version(), null);
        } else {
            List<String> taken = store.links(true).stream().map(Link::slug).toList();
            link = new Link(UUID.randomUUID().toString(), Slugs.of(p.name(), taken), p.name(), p.peerAlfredId(),
                    r.name() == null ? p.peerName() : r.name(), base, true, r.secret(), now, null, r.version(), null);
        }
        store.saveLink(link);
        store.clearEvents(link.id());
        transport.connect(link);
        notifications.changed("links-changed", Json.write(Map.of("id", link.id())));
        return link;
    }

    private void finish(String pairingId, Pairing.State state, String message, String linkId) {
        Pairing p = pairings.computeIfPresent(pairingId, (k, v) -> v.state() == Pairing.State.WAITING ? v.with(state, message, linkId) : v);
        if (p != null) {
            notifications.changed("pairings-changed", Json.write(p));
            // a finished pairing stays on the page for a while, then goes
            timer.schedule(() -> pairings.remove(pairingId), 10, TimeUnit.MINUTES);
        }
    }

    @Override
    public List<Pairing> pairings() {
        return pairings.values().stream().sorted(Comparator.comparing(Pairing::createdAt).reversed()).toList();
    }

    @Override
    public void cancel(String pairingId) {
        finish(pairingId, Pairing.State.CANCELLED, "Cancelled", null);
    }

    @Override
    public void dismiss(String pairingId) {
        Pairing p = pairings.get(pairingId);
        if (p != null && p.state() == Pairing.State.WAITING) {
            cancel(pairingId);
        }
        pairings.remove(pairingId);
        notifications.changed("pairings-changed", "{}");
    }

    // ---------------------------------------------------------------------------------------------- the asked side

    @Override
    public OfferAnswer offer(OfferIn in, String seenFrom) {
        if (in == null || in.alfredId() == null || in.alfredId().isBlank() || in.nonce() == null || in.nonce().length() < 16) {
            throw LinksProblem.bad("An offer needs the asking Alfred's id and a nonce");
        }
        Self self = links.self();
        if (in.alfredId().equals(self.alfredId())) {
            throw LinksProblem.bad("An Alfred cannot link with itself");
        }
        expire();
        long waiting = offers.values().stream().filter(h -> h.offer().state() == Offer.State.WAITING).count();
        if (waiting >= MAX_WAITING_OFFERS) {
            throw new LinksProblem("BUSY", 429, "Too many link requests are waiting here - try again in a few minutes");
        }
        // a second offer from the same Alfred replaces its first
        offers.values().removeIf(h -> h.offer().fromAlfredId().equals(in.alfredId()) && h.offer().state() == Offer.State.WAITING);
        Instant now = clock.instant();
        String name = in.name() == null || in.name().isBlank() ? "Alfred" : in.name().trim();
        Offer o = new Offer(UUID.randomUUID().toString(), Mac.code(), in.alfredId(), name.length() > 60 ? name.substring(0, 60) : name,
                in.address() != null && !in.address().isBlank() ? in.address() : seenFrom, in.version(), now, now.plus(OFFER_LIFE),
                Offer.State.WAITING, null);
        offers.put(o.id(), new Held(o, in.nonce(), new ArrayList<>(), null));
        timer.schedule(this::expire, OFFER_LIFE.toSeconds() + 1, TimeUnit.SECONDS);
        notifications.changed("offers-changed", Json.write(Map.of("id", o.id(), "code", o.code(), "from", o.fromName())));
        return new OfferAnswer(o.id(), o.code(), self.alfredId(), self.name(), self.version());
    }

    @Override
    public List<Offer> offers() {
        expire();
        return offers.values().stream().map(Held::offer).filter(o -> o.state() == Offer.State.WAITING)
                .sorted(Comparator.comparing(Offer::createdAt)).toList();
    }

    @Override
    public synchronized LinksUseCase.LinkInfo accept(String offerId, String name) {
        expire();
        Held h = offers.get(offerId);
        if (h == null || h.offer().state() != Offer.State.WAITING) {
            throw LinksProblem.conflict("ANSWERED", "That link request was already answered or has expired");
        }
        Offer o = h.offer();
        Instant now = clock.instant();
        String secret = Mac.random(32);
        String n = name == null || name.isBlank() ? o.fromName() : name.trim();
        if (n.length() > 40) {
            n = n.substring(0, 40);
        }
        Optional<Link> before = store.linkByPeer(o.fromAlfredId());
        Link link;
        if (before.isPresent()) {
            link = before.get().relinked(secret, false, o.fromAddress(), now).withName(n).withPeer(o.fromName(), o.fromVersion(), null);
        } else {
            List<String> taken = store.links(true).stream().map(Link::slug).toList();
            link = new Link(UUID.randomUUID().toString(), Slugs.of(n, taken), n, o.fromAlfredId(), o.fromName(), o.fromAddress(), false, secret,
                    now, null, o.fromVersion(), null);
        }
        store.saveLink(link);
        store.clearEvents(link.id());
        Held answered = new Held(o.with(Offer.State.ACCEPTED, link.id()), h.nonce(), h.waiters(), secret);
        offers.put(offerId, answered);
        Self self = links.self();
        for (CompletableFuture<OfferResult> w : h.waiters()) {
            w.complete(collect(offerId, self));
        }
        notifications.changed("offers-changed", "{}");
        notifications.changed("links-changed", Json.write(Map.of("id", link.id())));
        return links.info(link);
    }

    /** The secret goes out once; the offer is then collected and forgotten. */
    private synchronized OfferResult collect(String offerId, Self self) {
        Held h = offers.get(offerId);
        if (h == null) {
            return new OfferResult("EXPIRED", null, null, null, null);
        }
        return switch (h.offer().state()) {
            case ACCEPTED -> {
                offers.put(offerId, new Held(h.offer().with(Offer.State.COLLECTED, h.offer().linkId()), h.nonce(), List.of(), null));
                yield new OfferResult("ACCEPTED", h.secret(), self.alfredId(), self.name(), self.version());
            }
            case REJECTED -> new OfferResult("REJECTED", null, null, null, null);
            case WAITING -> new OfferResult("WAITING", null, null, null, null);
            default -> new OfferResult("EXPIRED", null, null, null, null);
        };
    }

    @Override
    public void reject(String offerId) {
        Held h = offers.get(offerId);
        if (h == null || h.offer().state() != Offer.State.WAITING) {
            throw LinksProblem.conflict("ANSWERED", "That link request was already answered or has expired");
        }
        offers.put(offerId, new Held(h.offer().with(Offer.State.REJECTED, null), h.nonce(), h.waiters(), null));
        for (CompletableFuture<OfferResult> w : h.waiters()) {
            w.complete(new OfferResult("REJECTED", null, null, null, null));
        }
        notifications.changed("offers-changed", "{}");
    }

    @Override
    public CompletableFuture<OfferResult> await(String offerId, String nonce) {
        expire();
        Held h = offers.get(offerId);
        if (h == null) {
            return CompletableFuture.completedFuture(new OfferResult("EXPIRED", null, null, null, null));
        }
        if (!Mac.same(h.nonce(), nonce)) {
            throw LinksProblem.forbidden("NOT_YOURS", "That link request is not yours");
        }
        if (h.offer().state() != Offer.State.WAITING) {
            return CompletableFuture.completedFuture(collect(offerId, links.self()));
        }
        CompletableFuture<OfferResult> f = new CompletableFuture<>();
        synchronized (this) {
            Held now = offers.get(offerId);
            if (now == null || now.offer().state() != Offer.State.WAITING) {
                return CompletableFuture.completedFuture(collect(offerId, links.self()));
            }
            now.waiters().add(f);
        }
        timer.schedule(() -> {
            if (f.complete(new OfferResult("WAITING", null, null, null, null))) {
                Held still = offers.get(offerId);
                if (still != null) {
                    synchronized (this) {
                        still.waiters().remove(f);
                    }
                }
            }
        }, WAIT.toSeconds(), TimeUnit.SECONDS);
        return f;
    }

    private void expire() {
        Instant now = clock.instant();
        boolean changed = false;
        for (Map.Entry<String, Held> e : offers.entrySet()) {
            Offer o = e.getValue().offer();
            if (o.expiresAt().isBefore(now)) {
                if (o.state() == Offer.State.WAITING) {
                    changed = true;
                    e.getValue().waiters().forEach(w -> w.complete(new OfferResult("EXPIRED", null, null, null, null)));
                }
                if (o.expiresAt().plus(OFFER_LIFE).isBefore(now) || o.state() == Offer.State.WAITING) {
                    offers.remove(e.getKey());
                }
            }
        }
        if (changed) {
            notifications.changed("offers-changed", "{}");
        }
        log.trace("offers: {}", offers.size());
    }
}
