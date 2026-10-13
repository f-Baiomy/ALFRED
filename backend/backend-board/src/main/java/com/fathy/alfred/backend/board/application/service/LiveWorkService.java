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
    static final int MAX_DRAFT = 16 * 1024;
    static final int MAX_RUNS = 200;

    private final BoardNotificationPort notifications;
    private final Clock clock;
    private final Map<String, LiveWork> runs = new ConcurrentHashMap<>();

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
        LiveWork next = new LiveWork(r.id(), r.project() == null ? "" : r.project(), r.cardNumber(),
                r.head() == null || r.head().isBlank() ? "working" : r.head().strip(), steps, draft,
                r.state() == null ? LiveWork.State.WORKING : r.state(), r.outcome(),
                previous != null && previous.stop(), previous == null ? now : previous.startedAt(), now);
        runs.put(next.id(), next);
        forgetOld(now);
        notifications.liveWork(next);
        return next;
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
