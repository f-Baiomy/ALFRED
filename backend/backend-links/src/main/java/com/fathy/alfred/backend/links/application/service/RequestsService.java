package com.fathy.alfred.backend.links.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RequestsUseCase;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.application.port.out.RequestApplyPort;
import com.fathy.alfred.backend.links.domain.RemoteRef;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.RequestKind;
import com.fathy.alfred.backend.links.domain.model.RequestState;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Requests (D10-D14). The reader sends while the owner is online and keeps a copy; the owner stores it WAITING, shows the
 * popup in every open page (D11) - or takes it at once when the stream auto-accepts (D12) - and tells the reader every
 * change with a durable event. The first answer wins: every answer is a compare-and-set on WAITING. A middle Alfred
 * passes a note on a third Alfred's call on to that Alfred and carries its answers back (D8).
 */
@Service
public class RequestsService implements RequestsUseCase {

    private static final Logger log = LoggerFactory.getLogger(RequestsService.class);

    static final int MAX_TEXT = 20_000;
    static final Duration SEND_WAIT = Duration.ofSeconds(30);

    /** The reader's request as it crosses the link. */
    record Wire(String id, String streamId, RequestKind kind, String target, String targetLabel, String text, String extra, boolean claude,
                String authorHint) {
    }

    /** An answer as the owner tells the reader. */
    record StateEvent(String id, RequestState state, String note, String resultRef, Instant answeredAt, boolean auto, String targetLabel) {
    }

    private final LinksStorePort store;
    private final RelayService relay;
    private final PeerTransportPort transport;
    private final LinksNotificationPort notifications;
    private final ObjectProvider<RequestApplyPort> apply;
    private final Clock clock;

    @Autowired
    public RequestsService(LinksStorePort store, RelayService relay, PeerTransportPort transport, LinksNotificationPort notifications,
                           ObjectProvider<RequestApplyPort> apply) {
        this(store, relay, transport, notifications, apply, Clock.systemUTC());
    }

    RequestsService(LinksStorePort store, RelayService relay, PeerTransportPort transport, LinksNotificationPort notifications,
                    ObjectProvider<RequestApplyPort> apply, Clock clock) {
        this.store = store;
        this.relay = relay;
        this.transport = transport;
        this.notifications = notifications;
        this.apply = apply;
        this.clock = clock;
    }

    private RequestApplyPort applier() {
        RequestApplyPort a = apply.getIfAvailable();
        if (a == null) {
            throw LinksProblem.conflict("UNSUPPORTED", "This Alfred cannot take requests");
        }
        return a;
    }

    private void changed(LinkRequest r) {
        notifications.changed("requests-changed", Json.write(Map.of("id", r.id(), "state", r.state().name(), "incoming", r.incoming(),
                "waiting", waiting())));
    }

    // ------------------------------------------------------------------------------------------------ the reader side

    @Override
    public LinkRequest send(SendIn in) {
        if (in == null || in.kind() == null || in.target() == null || in.target().isBlank() || in.streamId() == null) {
            throw LinksProblem.bad("A request needs a stream, a kind and a target");
        }
        String text = in.text() == null ? "" : in.text().strip();
        if (text.isEmpty() || text.length() > MAX_TEXT) {
            throw LinksProblem.bad("A text of 1 to " + MAX_TEXT + " characters");
        }
        Link link = store.linkBySlug(in.via()).filter(l -> !l.removed())
                .orElseThrow(() -> LinksProblem.notFound("The link " + in.via()));
        Stream stream = store.stream(in.streamId()).filter(s -> !s.mine() && s.linkId().equals(link.id()))
                .orElseThrow(() -> LinksProblem.notFound("That stream"));
        if (!stream.active()) {
            throw LinksProblem.conflict("ENDED", link.name() + " stopped this stream");
        }
        Wire wire = new Wire(UUID.randomUUID().toString(), stream.id(), in.kind(), in.target(), in.targetLabel(), text, in.extra(), in.claude(),
                null);
        JsonNode answer = post(link, "/links/peer/requests", Json.write(wire), List.of());
        LinkRequest mine = fromAnswer(answer, link, false);
        store.saveRequest(mine);
        changed(mine);
        return mine;
    }

    /** POST to the owner's peer API; its refusals come back as problems with their codes. */
    private JsonNode post(Link link, String path, String body, List<String> hops) {
        BlockingResponse.Whole w;
        try {
            w = relay.fetch(link.slug(), new RelayRequest("POST", path, "", Map.of("Content-Type", "application/json"), body, hops), SEND_WAIT,
                    1024 * 1024);
        } catch (LinkUnavailableException e) {
            throw new LinksProblem(e.code(), "OFFLINE".equals(e.code()) ? 503 : 502, e.getMessage());
        }
        JsonNode b = Json.tree(w.text());
        if (w.status() >= 400) {
            throw new LinksProblem(b.path("error").asText("REFUSED"), w.status(), b.path("message").asText(link.name() + " refused the request"));
        }
        return b;
    }

    private LinkRequest fromAnswer(JsonNode a, Link link, boolean incoming) {
        return new LinkRequest(a.path("id").asText(), a.path("streamId").asText(), link.id(), incoming, RequestKind.valueOf(a.path("kind").asText()),
                a.path("target").asText(), text(a, "targetLabel"), a.path("text").asText(""), text(a, "extra"), a.path("author").asText(""),
                RequestState.valueOf(a.path("state").asText("WAITING")), text(a, "resultRef"), text(a, "note"),
                instant(a, "createdAt", clock.instant()), instant(a, "answeredAt", null), a.path("auto").asBoolean(false));
    }

    private static String text(JsonNode n, String field) {
        return n.hasNonNull(field) ? n.path(field).asText() : null;
    }

    private static Instant instant(JsonNode n, String field, Instant fallback) {
        try {
            return n.hasNonNull(field) ? Instant.parse(n.path(field).asText()) : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    @Override
    public LinkRequest withdraw(String id) {
        LinkRequest r = store.request(id).filter(x -> !x.incoming()).orElseThrow(() -> LinksProblem.notFound("That request"));
        if (r.state() != RequestState.WAITING) {
            throw LinksProblem.conflict("ANSWERED", "That request was already answered");
        }
        Link link = store.link(r.linkId()).filter(l -> !l.removed()).orElseThrow(() -> LinksProblem.notFound("Its link"));
        JsonNode answer = post(link, "/links/peer/requests/" + id + "/withdraw", "{}", List.of());
        LinkRequest next = r.answered(RequestState.valueOf(answer.path("state").asText("WITHDRAWN")), text(answer, "resultRef"),
                text(answer, "note"), clock.instant(), answer.path("auto").asBoolean(false));
        store.saveRequest(next);
        changed(next);
        return next;
    }

    // ------------------------------------------------------------------------------------------------- the owner side

    /** The peer API: a linked Alfred sends a request (or passes on one for the Alfred behind it). */
    LinkRequest receive(Link from, List<String> hops, String body) {
        Wire w = Json.read(body, Wire.class);
        if (w.id() == null || w.kind() == null || w.target() == null || w.text() == null || w.text().isBlank() || w.text().length() > MAX_TEXT) {
            throw LinksProblem.bad("Not a request");
        }
        Optional<LinkRequest> repeat = store.request(w.id());
        if (repeat.isPresent()) {
            return repeat.get(); // the same request sent twice (a retry): the first one stands
        }
        Stream stream = store.stream(w.streamId()).filter(s -> s.mine() && s.active() && s.linkId().equals(from.id()))
                .orElseThrow(() -> LinksProblem.forbidden("NOT_STREAMED", "That is not streamed to you"));
        Optional<RemoteRef.Split> remote = RemoteRef.outer(w.target()).filter(sp -> relay.knows(sp.slug()));
        if (remote.isPresent()) {
            return passOn(from, hops, stream, w, remote.get());
        }
        int hop = Math.max(1, hops.size());
        if (hop > 1 && !stream.passOn()) {
            throw LinksProblem.forbidden("NOT_PASSED_ON", "The owner does not let this stream be passed on");
        }
        if (stream.modeFor(hop) != StreamMode.COMMENT) {
            throw LinksProblem.forbidden("VIEW_ONLY", "This stream is view only - the owner can switch it to comment");
        }
        String author = (w.authorHint() == null ? from.name() : w.authorHint() + " via " + from.name()) + (w.claude() ? " (Claude)" : "");
        LinkRequest r = new LinkRequest(w.id(), stream.id(), from.id(), true, w.kind(), w.target(), w.targetLabel(), w.text().strip(), w.extra(),
                author, RequestState.WAITING, null, null, clock.instant(), null, false);
        Optional<String> label = applier().allows(stream, r);
        if (label.isEmpty()) {
            throw LinksProblem.forbidden("NOT_ALLOWED", "That is not part of what is streamed to you");
        }
        r = new LinkRequest(r.id(), r.streamId(), r.linkId(), true, r.kind(), r.target(), label.get(), r.text(), r.extra(), r.author(),
                r.state(), null, null, r.createdAt(), null, false);
        store.saveRequest(r);
        changed(r);
        if (stream.autoAccept()) {
            try {
                return decide(r.id(), RequestState.ACCEPTED, null, true);
            } catch (RuntimeException e) {
                log.warn("Auto-accepting request {} failed: {}", r.id(), e.toString());
                return store.request(r.id()).orElse(r);
            }
        }
        return r;
    }

    /** A note on a third Alfred's call: sent on to it under its own stream to this Alfred, the answer carried back. */
    private LinkRequest passOn(Link from, List<String> hops, Stream offered, Wire w, RemoteRef.Split target) {
        if (w.kind() != RequestKind.CALL_NOTE) {
            throw LinksProblem.forbidden("NOT_ALLOWED", "Only notes on calls pass on to another Alfred");
        }
        Link far = store.linkBySlug(target.slug()).filter(l -> !l.removed())
                .orElseThrow(() -> LinksProblem.forbidden("NOT_STREAMED", "That call's Alfred is not linked here"));
        String cycleRef = cycleOf(w.extra());
        if (cycleRef == null) {
            throw LinksProblem.bad("A note on a passed-on call names its cycle");
        }
        LinkRequest probe = new LinkRequest(w.id(), offered.id(), from.id(), true, w.kind(), w.target(), w.targetLabel(), w.text(), w.extra(),
                from.name(), RequestState.WAITING, null, null, clock.instant(), null, false);
        if (applier().allows(offered, probe).isEmpty()) {
            throw LinksProblem.forbidden("NOT_ALLOWED", "That is not part of what is streamed to you");
        }
        String farCycle = RemoteRef.outer(cycleRef).filter(sp -> sp.slug().equals(far.slug())).map(RemoteRef.Split::inner).orElse(null);
        Stream farStream = store.streams().stream()
                .filter(s -> !s.mine() && s.active() && s.linkId().equals(far.id()) && s.kind() == StreamKind.CYCLE && s.target().equals(farCycle))
                .findFirst()
                .orElseThrow(() -> LinksProblem.forbidden("NOT_STREAMED", far.name() + " no longer streams that cycle"));
        ObjectNode extra = (ObjectNode) Json.tree(w.extra());
        extra.put("cycleId", farCycle);
        Wire onward = new Wire(w.id(), farStream.id(), w.kind(), target.inner(), w.targetLabel(), w.text(), extra.toString(), w.claude(),
                w.authorHint() == null ? from.name() : w.authorHint() + " via " + from.name());
        JsonNode answer = post(far, "/links/peer/requests", Json.write(onward), hops);
        LinkRequest kept = fromAnswer(answer, far, false);
        store.saveRequest(kept);
        store.relayFor(kept.id(), from.id());
        // what the reader gets back names the call as it knows it
        return new LinkRequest(kept.id(), w.streamId(), from.id(), true, kept.kind(), w.target(), kept.targetLabel(), kept.text(), w.extra(),
                kept.author(), kept.state(), kept.resultRef(), kept.note(), kept.createdAt(), kept.answeredAt(), kept.auto());
    }

    private static String cycleOf(String extra) {
        if (extra == null || extra.isBlank()) {
            return null;
        }
        JsonNode n = Json.tree(extra);
        return n.hasNonNull("cycleId") ? n.path("cycleId").asText() : null;
    }

    /** The peer API: the sender takes back a waiting request. */
    LinkRequest withdrawn(Link from, String id) {
        Optional<String> relayFor = store.relayedFor(id);
        if (relayFor.isPresent() && relayFor.get().equals(from.id())) {
            LinkRequest kept = store.request(id).orElseThrow(() -> LinksProblem.notFound("That request"));
            Link far = store.link(kept.linkId()).orElseThrow(() -> LinksProblem.notFound("Its link"));
            JsonNode answer = post(far, "/links/peer/requests/" + id + "/withdraw", "{}", List.of());
            LinkRequest next = kept.answered(RequestState.valueOf(answer.path("state").asText("WITHDRAWN")), null, null, clock.instant(), false);
            store.saveRequest(next);
            return next;
        }
        LinkRequest r = store.request(id).filter(x -> x.incoming() && x.linkId().equals(from.id()))
                .orElseThrow(() -> LinksProblem.notFound("That request"));
        LinkRequest next = r.answered(RequestState.WITHDRAWN, null, null, clock.instant(), false);
        if (!store.answerRequest(next, RequestState.WAITING)) {
            return store.request(id).orElse(r); // already answered: the sender gets the answer instead
        }
        changed(next);
        return next;
    }

    @Override
    public LinkRequest accept(String id) {
        return decide(id, RequestState.ACCEPTED, null, false);
    }

    @Override
    public LinkRequest reject(String id, String note) {
        String n = note == null ? null : note.strip();
        if (n != null && n.length() > 2000) {
            throw LinksProblem.bad("A note of up to 2000 characters");
        }
        return decide(id, RequestState.REJECTED, n == null || n.isEmpty() ? null : n, false);
    }

    private LinkRequest incoming(String id) {
        return store.request(id).filter(LinkRequest::incoming).orElseThrow(() -> LinksProblem.notFound("That request"));
    }

    private LinkRequest decide(String id, RequestState to, String note, boolean auto) {
        LinkRequest r = incoming(id);
        if (r.state() != RequestState.WAITING) {
            throw LinksProblem.conflict("ANSWERED", "That request was already answered (" + r.state().name().toLowerCase() + ")");
        }
        Instant now = clock.instant();
        LinkRequest claimed = r.answered(to, null, note, now, auto);
        if (!store.answerRequest(claimed, RequestState.WAITING)) {
            LinkRequest current = store.request(id).orElse(r);
            throw LinksProblem.conflict("ANSWERED", "That request was already answered (" + current.state().name().toLowerCase() + ")");
        }
        LinkRequest done = claimed;
        if (to == RequestState.ACCEPTED) {
            Stream stream = store.stream(r.streamId()).orElse(null);
            try {
                if (stream == null) {
                    throw new IllegalStateException("its stream is gone");
                }
                String ref = applier().apply(stream, r, r.author());
                done = claimed.answered(RequestState.ACCEPTED, ref, note, now, auto);
            } catch (RuntimeException e) {
                done = claimed.answered(RequestState.FAILED, null, "Could not be applied: " + (e.getMessage() == null ? e : e.getMessage()), now, auto);
            }
            store.saveRequest(done);
        }
        tellReader(done);
        changed(done);
        return done;
    }

    @Override
    public LinkRequest undo(String id) {
        LinkRequest r = incoming(id);
        if (r.state() != RequestState.ACCEPTED) {
            throw LinksProblem.conflict("NOT_ACCEPTED", "Only an accepted request can be undone");
        }
        LinkRequest next = r.answered(RequestState.UNDONE, null, null, clock.instant(), false);
        if (!store.answerRequest(next, RequestState.ACCEPTED)) {
            throw LinksProblem.conflict("ANSWERED", "That request changed meanwhile");
        }
        try {
            applier().undo(r);
        } catch (RuntimeException e) {
            store.saveRequest(r); // still accepted: what it made is still there
            throw LinksProblem.conflict("UNDO_FAILED", "Could not undo: " + e.getMessage());
        }
        tellReader(next);
        changed(next);
        return next;
    }

    private void tellReader(LinkRequest r) {
        StateEvent e = new StateEvent(r.id(), r.state(), r.note(), r.resultRef(), r.answeredAt(), r.auto(), r.targetLabel());
        store.enqueue(r.linkId(), "request-state", Json.write(e), clock.instant());
        transport.flush(r.linkId());
    }

    /** The owner answered one of this Alfred's requests - and, on a middle Alfred, the reader it passed it on for hears too. */
    void stateChanged(Link from, String data) {
        StateEvent e = Json.read(data, StateEvent.class);
        Optional<LinkRequest> mine = store.request(e.id()).filter(r -> !r.incoming() && r.linkId().equals(from.id()));
        if (mine.isEmpty()) {
            return;
        }
        LinkRequest next = mine.get().answered(e.state(), e.resultRef(), e.note(), e.answeredAt() == null ? clock.instant() : e.answeredAt(),
                e.auto());
        store.saveRequest(next);
        changed(next);
        store.relayedFor(e.id()).ifPresent(readerLink -> {
            store.enqueue(readerLink, "request-state", data, clock.instant());
            transport.flush(readerLink);
        });
    }

    @Override
    public List<LinkRequest> requests(Boolean incoming, RequestState state, String linkId, int limit) {
        return store.requests(incoming, state, linkId, limit);
    }

    @Override
    public int waiting() {
        return store.countRequests(true, RequestState.WAITING);
    }
}
