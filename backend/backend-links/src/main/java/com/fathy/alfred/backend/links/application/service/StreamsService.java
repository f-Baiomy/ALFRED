package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.StreamsUseCase;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.application.port.out.RemoteListenerPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Streams (D5-D8). The owner keeps its own row and tells the reader with a durable event, so a reader offline when a
 * stream starts or ends hears it on its next connect (D26); on every connect the reader also asks for the full list and
 * puts its copy right (in case a month offline dropped events).
 */
@Service
public class StreamsService implements StreamsUseCase {

    /** What the reader is told about a stream: the owner's row without the owner's link id. */
    record StreamEvent(String id, StreamKind kind, String target, String targetName, String project, StreamMode mode, boolean autoAccept,
                       boolean passOn, StreamMode passMode, boolean unmasked, String env, String forBoard, Instant createdAt, Instant endedAt) {

        static StreamEvent of(Stream s) {
            return new StreamEvent(s.id(), s.kind(), s.target(), s.targetName(), s.project(), s.mode(), s.autoAccept(), s.passOn(),
                    s.passMode(), s.unmasked(), s.env(), s.forBoard(), s.createdAt(), s.endedAt());
        }

        Stream asMirror(String linkId) {
            return new Stream(id, false, linkId, kind, target, targetName, project, mode, autoAccept, passOn, passMode == null ? StreamMode.VIEW
                    : passMode, unmasked, env, forBoard, createdAt, endedAt);
        }
    }

    private final LinksStorePort store;
    private final PeerTransportPort transport;
    private final LinksNotificationPort notifications;
    private final ObjectProvider<RemoteListenerPort> listeners;
    private final Clock clock;

    @Autowired
    public StreamsService(LinksStorePort store, PeerTransportPort transport, LinksNotificationPort notifications,
                          ObjectProvider<RemoteListenerPort> listeners) {
        this(store, transport, notifications, listeners, Clock.systemUTC());
    }

    StreamsService(LinksStorePort store, PeerTransportPort transport, LinksNotificationPort notifications,
                   ObjectProvider<RemoteListenerPort> listeners, Clock clock) {
        this.store = store;
        this.transport = transport;
        this.notifications = notifications;
        this.listeners = listeners;
        this.clock = clock;
    }

    private Link liveLink(String linkId) {
        Link l = store.link(linkId).orElseThrow(() -> LinksProblem.notFound("That link"));
        if (l.removed()) {
            throw LinksProblem.notFound("That link");
        }
        return l;
    }

    @Override
    public synchronized Stream start(StreamIn in) {
        if (in == null || in.kind() == null || in.target() == null || in.target().isBlank()) {
            throw LinksProblem.bad("A stream needs a kind and a target");
        }
        Link link = liveLink(in.linkId());
        if (in.target().contains("@")) {
            throw LinksProblem.bad("Only this Alfred's own cycles and boards can be streamed - a streamed-in one is passed on by its owner's switch");
        }
        StreamMode mode = in.mode() == null ? StreamMode.VIEW : in.mode();
        StreamMode passMode = in.passMode() == null ? StreamMode.VIEW : in.passMode();
        if (passMode == StreamMode.COMMENT && mode == StreamMode.VIEW) {
            passMode = StreamMode.VIEW; // passing on never gives more than the stream itself
        }
        Optional<Stream> same = store.streams().stream()
                .filter(s -> s.mine() && s.active() && s.linkId().equals(link.id()) && s.kind() == in.kind() && s.target().equals(in.target()))
                .findFirst();
        Stream s;
        if (same.isPresent()) {
            s = same.get().with(mode, in.autoAccept(), in.passOn(), passMode, in.unmasked());
            if (in.targetName() != null) {
                s = s.named(in.targetName(), in.project());
            }
        } else {
            s = new Stream(UUID.randomUUID().toString(), true, link.id(), in.kind(), in.target(), in.targetName(), in.project(), mode,
                    in.autoAccept(), in.passOn(), passMode, in.unmasked(), blankToNull(in.env()), blankToNull(in.forBoard()), clock.instant(), null);
        }
        store.saveStream(s);
        tell(s);
        return s;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private void tell(Stream s) {
        store.enqueue(s.linkId(), s.active() ? "stream" : "stream-ended", Json.write(StreamEvent.of(s)), clock.instant());
        transport.flush(s.linkId());
        notifications.changed("streams-changed", Json.write(Map.of("id", s.id())));
    }

    private Stream mine(String id) {
        Stream s = store.stream(id).orElseThrow(() -> LinksProblem.notFound("That stream"));
        if (!s.mine()) {
            throw LinksProblem.forbidden("NOT_OWNER", "Only the Alfred that streams it can change a stream");
        }
        return s;
    }

    @Override
    public synchronized Stream update(String id, StreamPatch patch) {
        Stream s = mine(id);
        if (!s.active()) {
            throw LinksProblem.conflict("ENDED", "That stream has ended - start it again");
        }
        StreamMode mode = patch.mode() == null ? s.mode() : patch.mode();
        StreamMode passMode = patch.passMode() == null ? s.passMode() : patch.passMode();
        if (mode == StreamMode.VIEW) {
            passMode = StreamMode.VIEW;
        }
        Stream next = s.with(mode, patch.autoAccept() == null ? s.autoAccept() : patch.autoAccept(),
                patch.passOn() == null ? s.passOn() : patch.passOn(), passMode, patch.unmasked() == null ? s.unmasked() : patch.unmasked());
        store.saveStream(next);
        tell(next);
        return next;
    }

    @Override
    public synchronized void stop(String id) {
        Stream s = mine(id);
        if (!s.active()) {
            return;
        }
        Stream ended = s.ended(clock.instant());
        store.saveStream(ended);
        tell(ended);
    }

    @Override
    public synchronized void forget(String id) {
        Stream s = store.stream(id).orElseThrow(() -> LinksProblem.notFound("That stream"));
        if (s.mine()) {
            throw LinksProblem.bad("Stop your own stream instead");
        }
        if (s.active()) {
            throw LinksProblem.conflict("ACTIVE", "Its owner still streams it - only an ended stream can be removed here");
        }
        store.deleteStream(id);
        notifications.changed("streams-changed", Json.write(Map.of("id", id)));
    }

    @Override
    public Optional<Stream> get(String id) {
        return store.stream(id);
    }

    @Override
    public List<Stream> streams(Boolean mine, String linkId, StreamKind kind, String target, boolean includeEnded) {
        return store.streams().stream()
                .filter(s -> mine == null || s.mine() == mine)
                .filter(s -> linkId == null || linkId.isBlank() || s.linkId().equals(linkId))
                .filter(s -> kind == null || s.kind() == kind)
                .filter(s -> target == null || target.isBlank() || s.target().equals(target))
                .filter(s -> includeEnded || s.active())
                .toList();
    }

    @Override
    public List<Stream> offeredTo(String linkId) {
        return store.streams().stream().filter(s -> s.mine() && s.active() && s.linkId().equals(linkId)).toList();
    }

    @Override
    public synchronized void renamed(StreamKind kind, String target, String name, String project) {
        for (Stream s : store.streams()) {
            if (s.mine() && s.active() && s.kind() == kind && s.target().equals(target)
                    && (name != null && !name.equals(s.targetName()) || project != null && !project.equals(s.project()))) {
                Stream next = s.named(name == null ? s.targetName() : name, project);
                store.saveStream(next);
                tell(next);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------- the reader side

    /** The owner told this Alfred about a stream: keep its copy (names only). */
    synchronized void mirror(Link from, String data, boolean ended) {
        StreamEvent e = Json.read(data, StreamEvent.class);
        Stream copy = e.asMirror(from.id());
        if (ended && copy.endedAt() == null) {
            copy = copy.ended(clock.instant());
        }
        Optional<Stream> before = store.stream(copy.id());
        if (before.isPresent() && before.get().mine()) {
            return; // an id clash with one of this Alfred's own streams: never overwrite it
        }
        store.saveStream(copy);
        notifications.changed("streams-changed", Json.write(Map.of("id", copy.id())));
        Stream changed = copy;
        listeners.orderedStream().forEach(l -> l.streamChanged(from, changed));
    }

    /** On connect: the owner's full list replaces this Alfred's copy (a stream missing from it has ended). */
    synchronized void reconcile(Link from, List<StreamEvent> offered) {
        Set<String> ids = new HashSet<>();
        for (StreamEvent e : offered) {
            ids.add(e.id());
            Stream copy = e.asMirror(from.id());
            Optional<Stream> before = store.stream(copy.id());
            if (before.isPresent() && before.get().mine()) {
                continue;
            }
            if (before.isEmpty() || !before.get().equals(copy)) {
                store.saveStream(copy);
                Stream changed = copy;
                listeners.orderedStream().forEach(l -> l.streamChanged(from, changed));
            }
        }
        Instant now = clock.instant();
        for (Stream s : store.streams()) {
            if (!s.mine() && s.active() && s.linkId().equals(from.id()) && !ids.contains(s.id())) {
                Stream ended = s.ended(now);
                store.saveStream(ended);
                listeners.orderedStream().forEach(l -> l.streamChanged(from, ended));
            }
        }
        notifications.changed("streams-changed", "{}");
    }

    List<StreamEvent> offeredEvents(String linkId) {
        return offeredTo(linkId).stream().map(StreamEvent::of).toList();
    }
}
