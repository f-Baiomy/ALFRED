package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.in.SkillRunsUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.SkillRunStorePort;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Pattern;

/**
 * Skills run from the board with ▶ (docs/board.md "Run from the board"). A run belongs to the chat that handles its
 * cycle - the Claude Code chat running /alfred-live or /alfred-listen for it: it is stored QUEUED for that chat,
 * claimed by the chat's runner, which writes it into the chat's watch (SENT); the chat takes it when its turn ends
 * (RUNNING) and ends it (DONE / FAILED) - all with the chat's own context, model and account. A cycle with no chat, a
 * project-level command: refused, the board copies instead. No timer: a run whose chat is gone reads as "lost" on read.
 */
@Service
public class SkillRunsService implements SkillRunsUseCase {

    private static final Logger log = LoggerFactory.getLogger(SkillRunsService.class);

    static final int MAX_COMMAND = 300;
    static final int MAX_PROMPT = 16 * 1024;
    static final int MAX_NOTE = 2000;
    static final int MAX_STEPS = 40;
    static final int MAX_STEP = 300;
    static final int MAX_OUTCOME = 500;
    static final int KEEP_PER_PROJECT = 500;
    /** A run still open this long after its cycle lost its chat is shown as lost (the chat was stopped or closed). */
    static final Duration LOST = Duration.ofMinutes(2);
    /** Finished runs of one skill whose durations make its "usually takes". */
    static final int USUAL_OF = 20;
    private static final Pattern COMMAND = Pattern.compile("^/[\\w:.-]+(\\s.*)?$", Pattern.DOTALL);

    private final SkillRunStorePort store;
    private final LiveWorkUseCase chats;
    private final BoardNotificationPort notifications;
    private final Clock clock;
    private final CopyOnWriteArrayList<Runnable> waiters = new CopyOnWriteArrayList<>();

    @Autowired
    public SkillRunsService(SkillRunStorePort store, LiveWorkUseCase chats, BoardNotificationPort notifications) {
        this(store, chats, notifications, Clock.systemUTC());
    }

    SkillRunsService(SkillRunStorePort store, LiveWorkUseCase chats, BoardNotificationPort notifications, Clock clock) {
        this.store = store;
        this.chats = chats;
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override
    public Outcome request(Request r) {
        String project = r.project() == null ? "" : r.project().strip();
        String command = r.command() == null ? "" : r.command().strip();
        if (command.isEmpty() || command.length() > MAX_COMMAND || !COMMAND.matcher(command).matches()) {
            return Outcome.refused("invalid", "A command starts with / (e.g. /alfred-fix 35), at most " + MAX_COMMAND + " characters");
        }
        String cycleId = blankToNull(r.cycleId());
        if (cycleId == null) {
            return Outcome.refused("invalid", "Only a cycle's commands run from the board, in the chat that handles the cycle - copy this one into a chat");
        }
        String prompt = r.prompt() == null || r.prompt().isBlank() ? command : r.prompt();
        if (prompt.length() > MAX_PROMPT) {
            return Outcome.refused("invalid", "The prompt is longer than " + MAX_PROMPT / 1024 + " KB");
        }
        String note = r.note() == null || r.note().isBlank() ? null : r.note().strip();
        if (note != null && note.length() > MAX_NOTE) {
            return Outcome.refused("invalid", "The note is longer than " + MAX_NOTE + " characters");
        }
        Optional<LiveWorkUseCase.CycleChat> chat = chats.cycleChat(cycleId);
        if (chat.isEmpty()) {
            return Outcome.refused("not-found", "No chat handles this cycle - start /alfred-live for it in a Claude Code chat, or copy the prompt");
        }
        String background = runsInBackground(command, chat.get());
        if (background != null) {
            return Outcome.refused("conflict", background + " - nothing to start; what it finds lands on the board as it comes");
        }
        Integer card = r.cardNumber() == null || r.cardNumber() <= 0 ? null : r.cardNumber();
        for (SkillRun a : store.activeRuns(project)) {
            if (!cycleId.equals(a.cycleId())) {
                continue;
            }
            boolean same = card != null ? card.equals(a.cardNumber()) : a.cardNumber() == null && a.command().equals(command);
            if (same) {
                return Outcome.refused("conflict", "Already " + (a.state() == SkillRun.State.RUNNING ? "running in the chat" : "waiting for the chat") + ": "
                        + a.command());
            }
        }
        Instant now = clock.instant();
        SkillRun run = new SkillRun(UUID.randomUUID().toString(), project, cycleId, card, command, prompt, note, null, null, SkillRun.State.QUEUED,
                null, null, null, false, null, List.of(), false, null, now, null, null, now, chat.get().chatId());
        store.saveRun(run);
        store.pruneRuns(project, KEEP_PER_PROJECT);
        notifications.skillRun(run);
        wake();
        return Outcome.ok(run);
    }

    @Override
    public Page list(String project, Integer cardNumber, int limit) {
        int clamped = limit <= 0 ? 50 : Math.min(limit, 200);
        Instant now = clock.instant();
        Map<String, SkillRun> out = new LinkedHashMap<>();
        for (SkillRun a : store.activeRuns(project)) {
            SkillRun shown = alreadyInBackground(a, now);
            if (cardNumber == null || cardNumber.equals(shown.cardNumber())) {
                out.put(shown.id(), lostOrAsIs(shown, now));
            }
        }
        for (SkillRun r : store.runs(project, cardNumber, clamped)) {
            out.putIfAbsent(r.id(), lostOrAsIs(r, now));
        }
        return new Page(List.copyOf(out.values()), usual(project));
    }

    /** The median duration of each skill's last finished runs in this project. */
    private Map<String, Long> usual(String project) {
        Map<String, List<Long>> bySkill = new LinkedHashMap<>();
        for (SkillRun r : store.runs(project, null, KEEP_PER_PROJECT)) {
            if (r.state() != SkillRun.State.DONE || r.takenAt() == null || r.endedAt() == null) {
                continue;
            }
            List<Long> list = bySkill.computeIfAbsent(r.skill(), k -> new ArrayList<>());
            if (list.size() < USUAL_OF) {
                list.add(Duration.between(r.takenAt(), r.endedAt()).toMillis());
            }
        }
        Map<String, Long> out = new LinkedHashMap<>();
        bySkill.forEach((skill, list) -> {
            List<Long> sorted = list.stream().sorted().toList();
            out.put(skill, sorted.get(sorted.size() / 2));
        });
        return out;
    }

    /**
     * "Already listening to this cycle on HOST in the background" when the command is a skill the cycle's chat already
     * runs as its own background process (/alfred-listen, /alfred-live) - queued, it would wait for the chat's turn
     * behind every other run for nothing; null otherwise.
     */
    static String runsInBackground(String command, LiveWorkUseCase.CycleChat chat) {
        String skill = command.strip().split("\\s+", 2)[0].replaceFirst("^/", "").replaceFirst("^.*:", "");
        String kind = switch (skill) {
            case "alfred-listen" -> "listen";
            case "alfred-live" -> "live";
            default -> null;
        };
        if (kind == null || chat.kinds() == null || !chat.kinds().contains(kind)) {
            return null;
        }
        String where = chat.host() == null || chat.host().isBlank() ? "" : " on " + chat.host();
        return (kind.equals("listen") ? "Already listening to this cycle" : "Already answering this cycle live") + where + " in the background";
    }

    /** A run left waiting for a skill the chat now runs in the background (it started since) is done with: cancelled, saying so. */
    private synchronized SkillRun alreadyInBackground(SkillRun run, Instant now) {
        if (run.state() != SkillRun.State.QUEUED && run.state() != SkillRun.State.SENT) {
            return run;
        }
        String background = chats.cycleChat(run.cycleId()).map(c -> runsInBackground(run.command(), c)).orElse(null);
        if (background == null) {
            return run;
        }
        SkillRun next = run.with(SkillRun.State.CANCELLED, background + " - this run was not needed", null, null, null, run.steps(), true,
                run.takenBy(), null, now, now);
        store.saveRun(next);
        notifications.skillRun(next);
        return next;
    }

    /** An open run whose cycle has had no chat for a while: the chat was stopped or closed - shown as lost. */
    private SkillRun lostOrAsIs(SkillRun r, Instant now) {
        if (r.active() && r.updatedAt().plus(LOST).isBefore(now) && chats.cycleChat(r.cycleId()).isEmpty()) {
            return r.with(SkillRun.State.FAILED, "the chat that handled this cycle stopped before the run ended", "lost", null, r.result(), r.steps(),
                    r.stop(), r.takenBy(), r.takenAt(), r.updatedAt(), r.updatedAt());
        }
        return r;
    }

    @Override
    public synchronized List<SkillRun> claim(String chatId, String host, int max) {
        Instant now = clock.instant();
        List<SkillRun> taken = new ArrayList<>();
        if (chatId == null || chatId.isBlank()) {
            return taken;
        }
        for (SkillRun a : store.activeRuns(null)) {
            if (taken.size() >= Math.max(0, max)) {
                break;
            }
            if (a.state() != SkillRun.State.QUEUED || alreadyInBackground(a, now).state() == SkillRun.State.CANCELLED) {
                continue;
            }
            // the run goes to whichever chat handles its cycle now (a chat restarted for the cycle takes what waited)
            Optional<LiveWorkUseCase.CycleChat> chat = chats.cycleChat(a.cycleId());
            if (chat.isEmpty() || !chat.get().chatId().equals(chatId)) {
                continue;
            }
            SkillRun next = a.with(SkillRun.State.SENT, null, null, null, null, a.steps(), false, host == null || host.isBlank() ? chat.get().host() : host.strip(),
                    null, null, now);
            store.saveRun(next);
            notifications.skillRun(next);
            taken.add(next);
        }
        return taken;
    }

    @Override
    public synchronized Optional<SkillRun> report(String id, Report r) {
        Optional<SkillRun> found = store.findRun(id);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        SkillRun run = found.get();
        if (!run.active()) {
            return Optional.of(run); // cancelled (or ended) meanwhile: the chat learns it here
        }
        Instant now = clock.instant();
        List<String> steps = r.steps() == null ? run.steps() : r.steps().stream()
                .map(s -> s == null ? "" : s.strip()).filter(s -> !s.isEmpty())
                .map(s -> s.length() > MAX_STEP ? s.substring(0, MAX_STEP) + "…" : s).toList();
        if (steps.size() > MAX_STEPS) {
            steps = steps.subList(steps.size() - MAX_STEPS, steps.size());
        }
        String outcome = r.outcome() == null || r.outcome().length() <= MAX_OUTCOME ? r.outcome() : r.outcome().substring(0, MAX_OUTCOME - 1) + "…";
        SkillRun.State state = r.state() == null ? SkillRun.State.RUNNING : r.state();
        SkillRun next = switch (state) {
            // handed back (the runner stopped before the chat took it): queued for the cycle's chat again
            case QUEUED -> run.with(SkillRun.State.QUEUED, null, null, r.retryAt(), run.result(), steps, false, null, null, null, now);
            case SENT -> run.with(SkillRun.State.SENT, run.outcome(), null, null, run.result(), steps, false, run.takenBy(), null, null, now);
            case RUNNING -> run.with(SkillRun.State.RUNNING, outcome, null, null, run.result(), steps, run.stop(), run.takenBy(),
                    run.takenAt() == null ? now : run.takenAt(), null, now);
            default -> run.with(state, outcome, state == SkillRun.State.DONE ? null : r.failure(), null, r.result() == null ? run.result() : r.result(),
                    steps, run.stop(), run.takenBy(), run.takenAt() == null ? now : run.takenAt(), now, now);
        };
        store.saveRun(next);
        notifications.skillRun(next);
        if (next.state() == SkillRun.State.QUEUED) {
            wake();
        }
        return Optional.of(next);
    }

    @Override
    public synchronized Optional<SkillRun> stop(String id) {
        Optional<SkillRun> found = store.findRun(id);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(cancel(found.get(), clock.instant()));
    }

    /** A run the chat has not taken yet is cancelled; one it is running is the chat's - it is not interrupted. */
    private SkillRun cancel(SkillRun run, Instant now) {
        if (run.state() == SkillRun.State.QUEUED || run.state() == SkillRun.State.SENT) {
            SkillRun next = run.with(SkillRun.State.CANCELLED, "cancelled before the chat took it", null, null, null, run.steps(), true, run.takenBy(),
                    null, now, now);
            store.saveRun(next);
            notifications.skillRun(next);
            return next;
        }
        return run;
    }

    @Override
    public synchronized int stopAll(String project) {
        Instant now = clock.instant();
        int n = 0;
        for (SkillRun a : store.activeRuns(project == null || project.isEmpty() ? null : project)) {
            if (cancel(a, now).state() == SkillRun.State.CANCELLED) {
                n++;
            }
        }
        return n;
    }

    @Override
    public AutoCloseable onQueued(Runnable listener) {
        waiters.add(listener);
        return () -> waiters.remove(listener);
    }

    private void wake() {
        for (Runnable w : waiters) {
            if (waiters.remove(w)) {
                try {
                    w.run();
                } catch (RuntimeException e) {
                    log.warn("A skill-run waiter failed: {}", e.toString());
                }
            }
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
