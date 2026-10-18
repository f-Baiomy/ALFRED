package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.application.port.in.SessionsUseCase;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsNotificationPort;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsStorePort;
import com.fathy.alfred.backend.sessions.domain.model.AuditEntry;
import com.fathy.alfred.backend.sessions.domain.model.BoardSession;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Helper;
import com.fathy.alfred.backend.sessions.domain.model.HelperCommand;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/** See {@link SessionsUseCase}. Commands wake the helpers waiting for them through {@link #onQueued} - no polling. */
@Service
public class SessionsService implements SessionsUseCase {

    static final int MAX_ARGS = 16 * 1024;
    static final int MAX_RESULT = 4000;
    static final int MAX_TEXT = 500;

    private final SessionsStorePort store;
    private final SessionsNotificationPort notifications;
    private final Clock clock;
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();

    @Autowired
    public SessionsService(SessionsStorePort store, SessionsNotificationPort notifications) {
        this(store, notifications, Clock.systemUTC());
    }

    SessionsService(SessionsStorePort store, SessionsNotificationPort notifications, Clock clock) {
        this.store = store;
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override
    public synchronized BoardSession report(Caller helper, Report r) {
        if (helper == null || !helper.isHelper()) {
            throw new IllegalArgumentException("Only a helper reports sessions");
        }
        if (r.boardId() == null || r.boardId().isBlank() || r.cliSessionId() == null || r.cliSessionId().isBlank()) {
            throw new IllegalArgumentException("A session report names its board and its Claude session id");
        }
        Instant now = clock.instant();
        Optional<BoardSession> before = r.id() != null && !r.id().isBlank() ? store.session(r.id()) : store.sessionByCli(r.cliSessionId());
        if (before.isPresent() && !before.get().user().equals(helper.user())) {
            throw new IllegalArgumentException("That session belongs to another user");
        }
        String today = LocalDate.ofInstant(now, ZoneOffset.UTC).toString();
        BoardSession b = before.orElse(null);
        boolean first = store.sessions("", r.boardId(), 1).isEmpty();
        long tokens = r.tokensToday() != null ? r.tokensToday() : b != null && today.equals(b.tokensDay()) ? b.tokensToday() : 0;
        BoardSession next = new BoardSession(
                b != null ? b.id() : UUID.randomUUID().toString(),
                r.boardId().strip(),
                text(r.project(), b == null ? "" : b.project()),
                r.cliSessionId().strip(),
                text(r.desktopId(), b == null ? null : b.desktopId()),
                helper.user(), helper.machine(), helper.keyId(),
                text(r.cwd(), b == null ? null : b.cwd()),
                text(r.title(), b == null ? null : b.title()),
                r.state() != null ? r.state() : b != null ? b.state() : BoardSession.State.STARTING,
                r.openIn() != null ? r.openIn() : b != null ? b.openIn() : BoardSession.OpenIn.NONE,
                r.lastChatSeq() != null ? r.lastChatSeq() : b != null ? b.lastChatSeq() : 0,
                tokens, today,
                b != null && b.current(),
                b != null ? b.createdAt() : now, now);
        store.putSession(next);
        if (first || Boolean.TRUE.equals(r.makeCurrent())) {
            store.makeCurrent(next.boardId(), next.id());
        }
        notifications.changed("sessions", next.boardId());
        return store.session(next.id()).orElse(next);
    }

    @Override
    public List<BoardSession> sessions(String project, String boardId, int limit) {
        return store.sessions(project == null ? "" : project, boardId == null ? "" : boardId, Math.max(1, Math.min(500, limit)));
    }

    @Override
    public Optional<BoardSession> current(String boardId) {
        return store.sessions("", boardId, 50).stream().filter(BoardSession::current).findFirst();
    }

    @Override
    public CommandOutcome queue(Caller caller, String helperKeyId, HelperCommand.Kind kind, String boardId, String project, String sessionId,
                                String args) {
        if (kind == null) {
            return new CommandOutcome(null, "INVALID", "What should the PC do?");
        }
        String target = helperKeyId == null || helperKeyId.isBlank() ? caller.helperKeyId() : helperKeyId.strip();
        Optional<Helper> h = store.helper(target);
        if (h.isEmpty() || h.get().revokedAt() != null || !h.get().user().equals(caller.user())) {
            return new CommandOutcome(null, "NOT_FOUND", "Not one of your PCs");
        }
        if (args != null && args.length() > MAX_ARGS) {
            return new CommandOutcome(null, "INVALID", "Too much for one command");
        }
        if (sessionId != null && !sessionId.isBlank()) {
            Optional<BoardSession> s = store.session(sessionId);
            if (s.isPresent() && !s.get().user().equals(caller.user())) {
                return new CommandOutcome(null, "HELD", "That session belongs to " + s.get().user());
            }
        }
        Instant now = clock.instant();
        HelperCommand c = new HelperCommand(UUID.randomUUID().toString(), target, caller.user(), kind, text(boardId, null), text(project, ""),
                text(sessionId, null), args == null || args.isBlank() ? "{}" : args, HelperCommand.State.QUEUED, null, now, now);
        store.putCommand(c);
        notifications.changed("commands", c.boardId());
        listeners.forEach(Runnable::run);
        return new CommandOutcome(c, null, null);
    }

    @Override
    public List<HelperCommand> commands(Caller caller, int limit) {
        return store.commandsOf(caller.user(), Math.max(1, Math.min(200, limit)));
    }

    @Override
    public List<HelperCommand> claim(Caller helper, int max) {
        if (helper == null || !helper.isHelper()) {
            return List.of();
        }
        List<HelperCommand> taken = store.takeCommands(helper.keyId(), Math.max(1, Math.min(20, max)), clock.instant());
        if (!taken.isEmpty()) {
            notifications.changed("commands", null);
        }
        return taken;
    }

    @Override
    public AutoCloseable onQueued(Runnable listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener);
    }

    @Override
    public Optional<HelperCommand> report(Caller helper, String id, HelperCommand.State state, String result) {
        Optional<HelperCommand> c = store.command(id);
        if (c.isEmpty() || helper == null || !c.get().helperKeyId().equals(helper.keyId()) || state == null) {
            return Optional.empty();
        }
        String r = result == null ? null : result.length() > MAX_RESULT ? result.substring(0, MAX_RESULT) : result;
        HelperCommand next = c.get().with(state, r, clock.instant());
        store.putCommand(next);
        notifications.changed("commands", next.boardId());
        return Optional.of(next);
    }

    @Override
    public Optional<HelperCommand> cancel(Caller caller, String id) {
        Optional<HelperCommand> c = store.command(id);
        if (c.isEmpty() || !c.get().user().equals(caller.user()) || c.get().state() != HelperCommand.State.QUEUED) {
            return Optional.empty();
        }
        HelperCommand next = c.get().with(HelperCommand.State.CANCELLED, "cancelled", clock.instant());
        store.putCommand(next);
        notifications.changed("commands", next.boardId());
        return Optional.of(next);
    }

    @Override
    public void audit(String boardId, String what, Optional<Caller> caller, String via) {
        if (boardId == null || boardId.isBlank()) {
            return;
        }
        store.audit(new AuditEntry(0, clock.instant(), boardId, clip(what), caller.map(Caller::user).orElse("unpaired"),
                caller.map(Caller::machine).orElse(""), clip(via)));
    }

    @Override
    public List<AuditEntry> audit(String boardId, int limit) {
        return store.audit(boardId, Math.max(1, Math.min(1000, limit)));
    }

    private static String text(String v, String fallback) {
        if (v == null || v.isBlank()) {
            return fallback;
        }
        String s = v.strip();
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s;
    }

    private static String clip(String s) {
        return text(s, "");
    }
}
