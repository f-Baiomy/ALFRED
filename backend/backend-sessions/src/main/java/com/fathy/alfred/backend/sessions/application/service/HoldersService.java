package com.fathy.alfred.backend.sessions.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.sessions.application.port.in.HoldersUseCase;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsNotificationPort;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsStorePort;
import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.AuditEntry;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Helper;
import com.fathy.alfred.backend.sessions.domain.model.Holder;
import com.fathy.alfred.backend.sessions.domain.model.PendingMessage;
import com.fathy.alfred.backend.sessions.domain.model.WriteDecision;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;

/**
 * See {@link HoldersUseCase}. Every change is one audit line on the board. The away rule (My settings) is applied when
 * someone asks for a board whose holder has had no helper online for longer than the holder allowed.
 */
@Service
public class HoldersService implements HoldersUseCase {

    static final int MAX_NOTE = 500;
    static final int MAX_COMMENTERS = 20;

    private final SessionsStorePort store;
    private final SessionsNotificationPort notifications;
    private final Clock clock;
    private final ObjectMapper json = new ObjectMapper();

    @Autowired
    public HoldersService(SessionsStorePort store, SessionsNotificationPort notifications) {
        this(store, notifications, Clock.systemUTC());
    }

    HoldersService(SessionsStorePort store, SessionsNotificationPort notifications, Clock clock) {
        this.store = store;
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override
    public Optional<Holder> holder(String boardId) {
        return boardId == null || boardId.isBlank() ? Optional.empty() : store.holder(boardId);
    }

    @Override
    public List<Holder> holders(String project) {
        return store.holders(project == null ? "" : project);
    }

    @Override
    public WriteDecision mayWrite(Optional<Caller> caller, String boardId, WriteDecision.Kind kind) {
        Optional<Holder> h = holder(boardId);
        if (h.isEmpty()) {
            return WriteDecision.allow(WriteDecision.FREE);
        }
        if (caller.isPresent() && caller.get().user().equals(h.get().user())) {
            return WriteDecision.allow(WriteDecision.HOLDER);
        }
        if (caller.isPresent() && kind == WriteDecision.Kind.COMMENT && h.get().commenters().contains(caller.get().user())) {
            return WriteDecision.allow(WriteDecision.COMMENTER);
        }
        return WriteDecision.held(h.get());
    }

    @Override
    public synchronized Result take(Caller caller, String boardId, String project, String sessionId) {
        if (boardId == null || boardId.isBlank()) {
            return Result.refused("INVALID", "Which board?");
        }
        Optional<Holder> now = store.holder(boardId);
        if (now.isPresent() && !now.get().user().equals(caller.user())) {
            return Result.refused("HELD", "Held by " + now.get().user() + " on " + now.get().machine() + " - ask them for it");
        }
        Holder next = now.map(h -> h.withSession(caller.machine(), blankToNull(sessionId, h.sessionId())))
                .orElseGet(() -> new Holder(boardId, clean(project), caller.user(), caller.machine(), blankToNull(sessionId, null),
                        clock.instant(), List.of(), null));
        store.putHolder(next);
        if (now.isEmpty()) {
            audit(boardId, "Board taken", caller.user(), caller.machine(), "session " + shortId(sessionId));
        }
        notifications.changed("holders", boardId);
        return Result.ok(next);
    }

    @Override
    public synchronized Result release(Caller caller, String boardId) {
        Optional<Holder> h = store.holder(boardId);
        if (h.isEmpty()) {
            return Result.refused("NOT_FOUND", "Nobody holds this board");
        }
        if (!h.get().user().equals(caller.user())) {
            return Result.refused("HELD", "Only " + h.get().user() + " can release it");
        }
        store.removeHolder(boardId);
        audit(boardId, "Board released", caller.user(), caller.machine(), "");
        notifications.changed("holders", boardId);
        return Result.ok(h.get());
    }

    @Override
    public synchronized Result request(Caller caller, String boardId, String note) {
        Optional<Holder> h = store.holder(boardId);
        if (h.isEmpty()) {
            return Result.refused("NOT_FOUND", "Nobody holds this board - take it with ▶ alfred-live");
        }
        if (h.get().user().equals(caller.user())) {
            return Result.refused("INVALID", "You hold this board already");
        }
        Holder.Request r = new Holder.Request(caller.user(), caller.machine(), clip(note), clock.instant());
        Holder asked = h.get().withRequest(r);
        String away = awayAction(h.get());
        if ("accept".equals(away)) {
            return handOver(asked, "away rule: handed over");
        }
        if ("release".equals(away)) {
            store.removeHolder(boardId);
            audit(boardId, "Board released (away rule)", h.get().user(), h.get().machine(), "asked by " + caller.user());
            notifications.changed("holders", boardId);
            return Result.ok(asked);
        }
        store.putHolder(asked);
        audit(boardId, "Asked for the board", caller.user(), caller.machine(), r.note());
        notifications.changed("holders", boardId);
        return Result.ok(asked);
    }

    @Override
    public synchronized Result answer(Caller caller, String boardId, Answer answer) {
        Optional<Holder> h = store.holder(boardId);
        if (h.isEmpty()) {
            return Result.refused("NOT_FOUND", "Nobody holds this board");
        }
        if (!h.get().user().equals(caller.user())) {
            return Result.refused("HELD", "Only " + h.get().user() + " can answer");
        }
        if (h.get().request() == null) {
            return Result.refused("INVALID", "Nobody asked for this board");
        }
        return switch (answer) {
            case HAND_OVER -> handOver(h.get(), "handed over by " + caller.user());
            case RELEASE -> {
                store.removeHolder(boardId);
                audit(boardId, "Board released", caller.user(), caller.machine(), "asked by " + h.get().request().user());
                notifications.changed("holders", boardId);
                yield Result.ok(h.get());
            }
            case KEEP -> {
                Holder kept = h.get().withRequest(null);
                store.putHolder(kept);
                audit(boardId, "Kept the board", caller.user(), caller.machine(), "asked by " + h.get().request().user());
                notifications.changed("holders", boardId);
                yield Result.ok(kept);
            }
        };
    }

    @Override
    public synchronized Result commenters(Caller caller, String boardId, List<String> users) {
        Optional<Holder> h = store.holder(boardId);
        if (h.isEmpty() || !h.get().user().equals(caller.user())) {
            return Result.refused("HELD", "Only the board's holder names its commenters");
        }
        LinkedHashSet<String> clean = new LinkedHashSet<>();
        for (String u : users == null ? List.<String>of() : users) {
            String v = Keys.user(u);
            if (v.contains("@") && !v.equals(caller.user()) && clean.size() < MAX_COMMENTERS) {
                clean.add(clip(v));
            }
        }
        Holder next = h.get().withCommenters(new ArrayList<>(clean));
        store.putHolder(next);
        audit(boardId, "Commenters: " + (clean.isEmpty() ? "none" : String.join(", ", clean)), caller.user(), caller.machine(), "");
        notifications.changed("holders", boardId);
        return Result.ok(next);
    }

    static final int MAX_MESSAGE = 16 * 1024;

    @Override
    public synchronized PendingOutcome submit(Caller caller, String boardId, String project, String scope, String text) {
        Optional<Holder> h = store.holder(boardId);
        if (h.isEmpty() || !h.get().commenters().contains(caller.user())) {
            return new PendingOutcome(null, "HELD", "Only the board's commenters wait in its queue");
        }
        String t = text == null ? "" : text.strip();
        if (t.isEmpty() || t.length() > MAX_MESSAGE) {
            return new PendingOutcome(null, "INVALID", "A message of 1 to " + MAX_MESSAGE + " characters");
        }
        PendingMessage m = new PendingMessage(0,
                boardId, clean(project), scope == null || scope.isBlank() ? "project" : scope.strip(), caller.user(), caller.machine(), t, clock.instant());
        long id = store.addPending(m);
        notifications.changed("holders", boardId);
        return new PendingOutcome(store.pendingMessage(id).orElse(m), null, null);
    }

    @Override
    public List<PendingMessage> pending(Caller caller, String boardId) {
        Optional<Holder> h = store.holder(boardId);
        if (h.isEmpty()) {
            return List.of();
        }
        List<PendingMessage> all = store.pending(boardId);
        return h.get().user().equals(caller.user()) ? all : all.stream().filter(m -> m.user().equals(caller.user())).toList();
    }

    @Override
    public synchronized PendingOutcome resolve(Caller caller, long id, boolean letClaudeAnswer) {
        Optional<PendingMessage> m = store.pendingMessage(id);
        if (m.isEmpty()) {
            return new PendingOutcome(null, "NOT_FOUND", "No such waiting message");
        }
        Optional<Holder> h = store.holder(m.get().boardId());
        if (h.isEmpty() || !h.get().user().equals(caller.user())) {
            return new PendingOutcome(null, "HELD", "Only the board's holder lets Claude answer it");
        }
        store.removePending(id);
        audit(m.get().boardId(), (letClaudeAnswer ? "Let Claude answer " : "Declined ") + m.get().user() + "'s message", caller.user(), caller.machine(), "");
        notifications.changed("holders", m.get().boardId());
        return new PendingOutcome(m.get(), null, letClaudeAnswer ? "@" + m.get().user() + " asks: " + m.get().text() : null);
    }

    @Override
    public synchronized Result forceRelease(String boardId) {
        Optional<Holder> h = store.holder(boardId);
        if (h.isEmpty()) {
            return Result.refused("NOT_FOUND", "Nobody holds this board");
        }
        store.removeHolder(boardId);
        audit(boardId, "Force release (admin)", "admin", "server", "was held by " + h.get().user());
        notifications.changed("holders", boardId);
        return Result.ok(h.get());
    }

    @Override
    public synchronized List<String> releaseAllOf(String user, String why) {
        List<String> out = new ArrayList<>();
        for (Holder h : store.heldBy(user)) {
            store.removeHolder(h.boardId());
            audit(h.boardId(), "Board released (" + why + ")", user, h.machine(), "");
            out.add(h.boardId());
        }
        if (!out.isEmpty()) {
            notifications.changed("holders", null);
        }
        return out;
    }

    private Result handOver(Holder h, String why) {
        Holder.Request r = h.request();
        Holder next = new Holder(h.boardId(), h.project(), r.user(), r.machine(), null, clock.instant(), List.of(), null);
        store.putHolder(next);
        audit(h.boardId(), "Board handed over to " + r.user(), h.user(), h.machine(), why);
        notifications.changed("holders", h.boardId());
        return Result.ok(next);
    }

    /**
     * The holder's away rule when it applies now: "accept", "release" - or null (no rule, "nothing", or the holder has a
     * helper online or one seen within the rule's hours).
     */
    String awayAction(Holder h) {
        JsonNode away;
        try {
            away = json.readTree(store.settings(h.user()).orElse("{}")).path("away");
        } catch (Exception e) {
            return null;
        }
        String action = away.path("action").asText("nothing");
        double hours = away.path("hours").asDouble(0);
        if (hours <= 0 || !("accept".equals(action) || "release".equals(action))) {
            return null;
        }
        Instant now = clock.instant();
        Instant last = store.helpersOf(h.user()).stream().filter(x -> x.revokedAt() == null).map(Helper::lastSeen)
                .filter(java.util.Objects::nonNull).max(Instant::compareTo).orElse(Instant.EPOCH);
        return last.plus(Duration.ofMinutes(Math.round(hours * 60))).isBefore(now) ? action : null;
    }

    private void audit(String boardId, String what, String user, String machine, String via) {
        store.audit(new AuditEntry(0, clock.instant(), boardId, what, user, machine, via));
    }

    private static String clip(String s) {
        if (s == null) {
            return "";
        }
        String v = s.strip();
        return v.length() > MAX_NOTE ? v.substring(0, MAX_NOTE) : v;
    }

    private static String clean(String s) {
        return s == null ? "" : s.strip();
    }

    private static String blankToNull(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s.strip();
    }

    private static String shortId(String id) {
        return id == null || id.isBlank() ? "-" : id.length() > 8 ? id.substring(0, 8) : id;
    }
}
