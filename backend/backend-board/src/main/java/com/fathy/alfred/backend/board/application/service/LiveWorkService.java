package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Claude's live work per card, for the board to show while it happens (docs/board.md "Live answers"). Each report
 * replaces the run's state and is signalled on /ws/board. Nothing is stored: a run that ended is kept for
 * {@link #KEEP_ENDED} so the card can show how it went, and one that stopped reporting for {@link #STALE} reads as
 * FAILED - both computed on read, never on a timer.
 */
@Service
public class LiveWorkService implements LiveWorkUseCase {

    static final Duration KEEP_ENDED = Duration.ofMinutes(30);
    static final Duration STALE = Duration.ofMinutes(5);
    static final int MAX_STEPS = 40;
    static final int MAX_STEP = 300;
    static final int MAX_OUTCOME = 500;
    static final int MAX_DRAFT = 16 * 1024;
    static final int MAX_RUNS = 200;

    private final BoardNotificationPort notifications;
    private final Clock clock;
    private final Map<String, LiveWork> runs = new ConcurrentHashMap<>();
    /** One heartbeat per board and kind: a listen runner beating beside the live runner never replaces it. */
    private final Map<RunnerSlot, LiveRunner> runners = new ConcurrentHashMap<>();
    /** A runner beats at least every wait (50 s); quiet this long, it is gone. */
    static final Duration RUNNER_ALIVE = Duration.ofMinutes(2);

    private record RunnerSlot(String project, String kind) {
    }

    /** cycle id -> the chat that handles it. */
    private final Map<String, CycleChat> chats = new ConcurrentHashMap<>();
    private final Map<String, String> lastCwd = new ConcurrentHashMap<>();

    @Autowired
    public LiveWorkService(BoardNotificationPort notifications) {
        this(notifications, Clock.systemUTC());
    }

    LiveWorkService(BoardNotificationPort notifications, Clock clock) {
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override
    public LiveWork report(Report r) {
        Instant now = clock.instant();
        LiveWork previous = runs.get(r.id());
        List<String> steps = (r.steps() == null ? List.<String>of() : r.steps()).stream()
                .map(s -> s == null ? "" : s.strip()).filter(s -> !s.isEmpty())
                .map(s -> s.length() > MAX_STEP ? s.substring(0, MAX_STEP) + "…" : s).toList();
        if (steps.size() > MAX_STEPS) {
            steps = steps.subList(steps.size() - MAX_STEPS, steps.size());
        }
        String draft = r.draft() == null ? null : r.draft().length() > MAX_DRAFT ? r.draft().substring(0, MAX_DRAFT) : r.draft();
        String outcome = r.outcome() == null || r.outcome().length() <= MAX_OUTCOME ? r.outcome()
                : r.outcome().substring(0, MAX_OUTCOME - 1) + "…";
        LiveWork next = new LiveWork(r.id(), r.project() == null ? "" : r.project(), r.cardNumber(),
                r.head() == null || r.head().isBlank() ? "working" : r.head().strip(), steps, draft,
                r.state() == null ? LiveWork.State.WORKING : r.state(), outcome,
                previous != null && previous.stop(), previous == null ? now : previous.startedAt(), now);
        runs.put(next.id(), next);
        forgetOld(now);
        runnersAreAlive(next.project(), now);
        notifications.liveWork(next);
        return next;
    }

    /**
     * A report is proof that the runner answering this board is working, even through a long run during which it cannot
     * beat: the heartbeat that answers this project (its own, else the one for every board) is refreshed - but only while
     * it is still alive, so a report never brings back a runner that stopped or went quiet.
     */
    private void runnersAreAlive(String project, Instant now) {
        for (String kind : List.of(KIND_LIVE, KIND_LISTEN)) {
            RunnerSlot own = new RunnerSlot(project, kind);
            RunnerSlot slot = alive(runners.get(own)).isPresent() ? own : new RunnerSlot("", kind);
            runners.computeIfPresent(slot, (k, runner) -> alive(runner).isPresent() ? runner.seenAt(now) : runner);
        }
    }

    @Override
    public List<LiveWork> current(String project) {
        Instant now = clock.instant();
        forgetOld(now);
        List<LiveWork> out = new ArrayList<>();
        for (LiveWork w : runs.values()) {
            if (project != null && !project.equals(w.project())) {
                continue;
            }
            out.add(!w.ended() && w.updatedAt().plus(STALE).isBefore(now)
                    ? new LiveWork(w.id(), w.project(), w.cardNumber(), w.head(), w.steps(), w.draft(), LiveWork.State.FAILED,
                    "stopped reporting", w.stop(), w.startedAt(), w.updatedAt())
                    : w);
        }
        out.sort(Comparator.comparing(LiveWork::startedAt).thenComparing(LiveWork::id));
        return out;
    }

    @Override
    public LiveRunner beat(String project, String host, String model, String kind, boolean stopped) {
        Instant now = clock.instant();
        String key = project == null ? "" : project;
        String runnerKind = kindOf(kind);
        RunnerSlot slot = new RunnerSlot(key, runnerKind);
        LiveRunner previous = alive(runners.get(slot)).orElse(null);
        LiveRunner next = new LiveRunner(key, host == null || host.isBlank() ? "?" : host.strip(), model == null || model.isBlank() ? null : model.strip(),
                runnerKind, previous == null ? now : previous.startedAt(), now);
        if (stopped) {
            runners.remove(slot);
        } else {
            runners.put(slot, next);
        }
        if (stopped || previous == null) {
            notifications.liveRunner(key, stopped ? null : next.host(), runnerKind);
        }
        return next;
    }

    @Override
    public synchronized ChatBeat chatBeat(String project, String cycleId, String chatId, String host, String cwd, String kind, boolean chatAlive,
                                          boolean stopped) {
        Instant now = clock.instant();
        String p = project == null ? "" : project;
        String k = kindOf(kind);
        CycleChat held = liveChat(chats.get(cycleId), now);
        if (held != null && !held.chatId().equals(chatId)) {
            return new ChatBeat(held, true);
        }
        if (cwd != null && !cwd.isBlank()) {
            lastCwd.put(p, cwd.strip());
        }
        if (stopped) {
            if (held == null) {
                return new ChatBeat(null, false);
            }
            java.util.Set<String> kinds = new java.util.TreeSet<>(held.kinds());
            kinds.remove(k);
            if (kinds.isEmpty()) {
                chats.remove(cycleId);
                notifications.cycleChat(p, cycleId);
                return new ChatBeat(null, false);
            }
            CycleChat next = new CycleChat(p, cycleId, chatId, held.host(), held.cwd(), java.util.Set.copyOf(kinds), held.chatAlive(), held.since(), now);
            chats.put(cycleId, next);
            notifications.cycleChat(p, cycleId);
            return new ChatBeat(next, false);
        }
        java.util.Set<String> kinds = new java.util.TreeSet<>(held == null ? java.util.Set.of() : held.kinds());
        kinds.add(k);
        CycleChat next = new CycleChat(p, cycleId, chatId, host == null || host.isBlank() ? "?" : host.strip(),
                cwd == null || cwd.isBlank() ? (held == null ? null : held.cwd()) : cwd.strip(), java.util.Set.copyOf(kinds), chatAlive,
                held == null ? now : held.since(), now);
        chats.put(cycleId, next);
        if (held == null || held.chatAlive() != chatAlive || !held.kinds().equals(next.kinds())) {
            notifications.cycleChat(p, cycleId);
        }
        return new ChatBeat(next, false);
    }

    @Override
    public Optional<CycleChat> cycleChat(String cycleId) {
        return cycleId == null ? Optional.empty() : Optional.ofNullable(liveChat(chats.get(cycleId), clock.instant()));
    }

    @Override
    public Optional<String> lastCwd(String project) {
        return Optional.ofNullable(lastCwd.get(project == null ? "" : project));
    }

    private static CycleChat liveChat(CycleChat c, Instant now) {
        return c == null || c.lastSeen().plus(RUNNER_ALIVE).isBefore(now) ? null : c;
    }

    @Override
    public Optional<LiveRunner> runner(String project, String kind) {
        if (kind == null || kind.isBlank()) {
            return runner(project, KIND_LIVE).or(() -> runner(project, KIND_LISTEN));
        }
        // A runner answering every board answers this one too.
        String key = project == null ? "" : project;
        String runnerKind = kindOf(kind);
        return alive(runners.get(new RunnerSlot(key, runnerKind)))
                .or(() -> key.isEmpty() ? Optional.empty() : alive(runners.get(new RunnerSlot("", runnerKind))));
    }

    /** "listen" for a listen runner; anything else - including nothing - is the live runner. */
    static String kindOf(String kind) {
        return kind != null && kind.strip().equalsIgnoreCase(KIND_LISTEN) ? KIND_LISTEN : KIND_LIVE;
    }

    private Optional<LiveRunner> alive(LiveRunner r) {
        return r == null || r.lastSeen().plus(RUNNER_ALIVE).isBefore(clock.instant()) ? Optional.empty() : Optional.of(r);
    }

    @Override
    public Optional<LiveWork> stop(String id) {
        LiveWork w = runs.get(id);
        if (w == null) {
            return Optional.empty();
        }
        LiveWork next = w.stopRequested(clock.instant());
        runs.put(id, next);
        notifications.liveWork(next);
        return Optional.of(next);
    }

    private void forgetOld(Instant now) {
        runs.values().removeIf(w -> (w.ended() || w.updatedAt().plus(STALE).isBefore(now)) && w.updatedAt().plus(KEEP_ENDED).isBefore(now));
        if (runs.size() > MAX_RUNS) {
            runs.values().stream().sorted(Comparator.comparing(LiveWork::updatedAt)).limit(runs.size() - MAX_RUNS)
                    .map(LiveWork::id).toList().forEach(runs::remove);
        }
    }
}
