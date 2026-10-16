package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.AppStartedUseCase;
import com.fathy.alfred.backend.board.application.port.in.RetestUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.CallFactsPort;
import com.fathy.alfred.backend.board.application.port.out.CycleCallsPort;
import com.fathy.alfred.backend.board.application.port.out.LiveCallsPort;
import com.fathy.alfred.backend.board.domain.RequirementJudge;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CallFacts;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CodeCheck;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.Expectation;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.RetestCheck;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.CallResult;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.Outcome;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.Result;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.StepResult;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.Verdict;
import com.fathy.alfred.backend.board.domain.model.RetestPlan;
import com.fathy.alfred.backend.board.domain.model.RetestRun;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * Re-testing a fix without recording a cycle (specs/016): every call to a Fixed card's endpoint made after the fix is
 * checked against the card's expectations - SQL count, status, log lines, duration, the response - with the value the
 * card's original call had beside it. A re-test cycle narrows the calls to the ones it captured. Verified and Done
 * cards with expectations stay guarded the same way. Reading is free for both actors; Verified stays the user's.
 */
@Service
public class RetestService implements RetestUseCase, AppStartedUseCase, com.fathy.alfred.backend.board.application.port.in.RetestWatchUseCase {

    /** Live calls read per check, newest first - a re-test happens soon after a fix. */
    static final int RECENT_CALLS = 2000;
    static final int CYCLE_CALLS = 5000;
    /** Calls checked per card, newest first: enough to tell flaky from fixed, cheap to read. */
    static final int CALLS_PER_CARD = 10;
    static final int HISTORY = 50;

    private final BoardStorePort store;
    private final CallFactsPort facts;
    private final LiveCallsPort liveCalls;
    private final CycleCallsPort cycleCalls;
    private final BoardNotificationPort notifications;
    private final Clock clock;
    /** One thread: the watch reads the board off the webhook's thread, in arrival order. */
    private final java.util.concurrent.ScheduledExecutorService watcher = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "board-retest-watch");
        t.setDaemon(true);
        return t;
    });
    /** The agent's statements and log lines arrive a little after the call: the card is signalled again then. */
    static final int LATE_SIGNAL_SECONDS = 20;

    @Autowired
    public RetestService(BoardStorePort store, CallFactsPort facts, LiveCallsPort liveCalls, CycleCallsPort cycleCalls,
                         BoardNotificationPort notifications, BoardChangeFeed feed) {
        this(store, facts, liveCalls, cycleCalls, notifications, feed, Clock.systemUTC());
    }

    RetestService(BoardStorePort store, CallFactsPort facts, LiveCallsPort liveCalls, CycleCallsPort cycleCalls,
                  BoardNotificationPort notifications, BoardChangeFeed feed, Clock clock) {
        this.store = store;
        this.facts = facts;
        this.liveCalls = liveCalls;
        this.cycleCalls = cycleCalls;
        this.notifications = feed.feeding(notifications);
        this.clock = clock;
    }

    // ------------------------------------------------------------------------------------------------------------- plan

    @Override
    public RetestPlan plan(String cardId) {
        return store.retestPlan(cardId).orElse(RetestPlan.empty(cardId));
    }

    @Override
    public PlanChange setPlan(Actor actor, String cardId, List<Expectation> expectations, List<RetestPlan.Step> steps) {
        Optional<Card> found = store.find(cardId);
        if (found.isEmpty()) {
            return new PlanChange(CardChange.Outcome.NOT_FOUND, null, "No such card");
        }
        Card card = found.get();
        if (actor == Actor.CLAUDE && (card.status() == CardStatus.DONE || card.status() == CardStatus.CLOSED)) {
            return new PlanChange(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, "The card is " + card.status().name().toLowerCase()
                    + " - only the user changes its re-test plan");
        }
        List<Expectation> exp = expectations == null ? List.of() : expectations;
        List<RetestPlan.Step> st = steps == null ? List.of() : steps;
        if (exp.size() > Expectation.MAX_PER_CARD) {
            return invalid("At most " + Expectation.MAX_PER_CARD + " expectations per card");
        }
        for (Expectation e : exp) {
            if (e == null || e.problem() != null) {
                return invalid(e == null ? "An expectation is empty" : e.problem());
            }
        }
        if (st.size() > RetestPlan.MAX_STEPS) {
            return invalid("At most " + RetestPlan.MAX_STEPS + " steps per card");
        }
        for (RetestPlan.Step s : st) {
            if (s == null || s.text().isEmpty() || s.text().length() > RetestPlan.MAX_STEP_TEXT
                    || (s.endpoint() != null && s.endpoint().length() > 300)) {
                return invalid("A step needs a text of at most " + RetestPlan.MAX_STEP_TEXT + " characters");
            }
            if (s.request().size() > RetestPlan.Step.MAX_CONDITIONS) {
                return invalid("At most " + RetestPlan.Step.MAX_CONDITIONS + " request conditions per step");
            }
            for (RetestPlan.When w : s.request()) {
                if (w == null || w.problem() != null) {
                    return invalid(w == null ? "A step's request condition is empty" : w.problem());
                }
            }
        }
        RetestPlan plan = new RetestPlan(cardId, exp, st, actor, clock.instant());
        store.putRetestPlan(plan);
        notifications.changed(card.project(), card.cycleId(), cardId, "retest");
        return new PlanChange(CardChange.Outcome.OK, plan, null, unknownEndpoints(card, st));
    }

    /**
     * A step naming an endpoint no recorded call ever hit never ticks (specs/020): say so when the plan is saved, with
     * the recorded endpoint it most likely means - same method, the most path segments in common from the end.
     */
    private List<String> unknownEndpoints(Card card, List<RetestPlan.Step> steps) {
        List<String> named = steps.stream().map(RetestPlan.Step::endpoint).filter(e -> e != null).distinct().toList();
        if (named.isEmpty()) {
            return List.of();
        }
        java.util.Map<String, Long> seen = new java.util.HashMap<>();
        List<CycleCall> calls = new ArrayList<>(liveCalls.recent(RECENT_CALLS));
        if (card.cycleId() != null) {
            calls.addAll(cycleCalls.calls(card.cycleId(), CYCLE_CALLS));
        }
        calls.stream().map(CycleCall::endpoint).filter(e -> e != null).forEach(e -> seen.merge(e, 1L, Long::sum));
        if (seen.isEmpty()) {
            return List.of(); // nothing recorded yet: nothing to compare with
        }
        List<String> out = new ArrayList<>();
        for (String ep : named) {
            if (seen.containsKey(ep)) {
                continue;
            }
            String near = closest(ep, seen.keySet());
            out.add("No recorded call ever hit " + ep + " - the step cannot tick until one does."
                    + (near == null ? "" : " Did you mean " + near + " (" + seen.get(near) + (seen.get(near) == 1 ? " call" : " calls") + ")?")
                    + " Saved as written.");
        }
        return out;
    }

    /** The recorded endpoint with the same method and the longest shared tail of path segments (at least 2), or null. */
    static String closest(String endpoint, java.util.Collection<String> recorded) {
        String[] want = endpoint.split(" ", 2);
        if (want.length < 2) {
            return null;
        }
        String[] wantSegs = want[1].replaceAll("^/+|/+$", "").split("/");
        String best = null;
        int bestScore = 0;
        for (String r : recorded) {
            String[] got = r.split(" ", 2);
            if (got.length < 2 || !got[0].equalsIgnoreCase(want[0])) {
                continue;
            }
            String[] gotSegs = got[1].replaceAll("^/+|/+$", "").split("/");
            int score = 0;
            while (score < wantSegs.length && score < gotSegs.length
                    && wantSegs[wantSegs.length - 1 - score].equalsIgnoreCase(gotSegs[gotSegs.length - 1 - score])) {
                score++;
            }
            if (score > bestScore || (score == bestScore && best != null && score > 0 && r.length() < best.length())) {
                bestScore = score;
                best = r;
            }
        }
        return bestScore >= Math.min(2, wantSegs.length) ? best : null;
    }

    private static PlanChange invalid(String message) {
        return new PlanChange(CardChange.Outcome.INVALID, null, message);
    }

    // ------------------------------------------------------------------------------------------------------------ check

    @Override
    public List<RetestCheck> check(String project, List<Integer> numbers, String cycleId) {
        List<Card> cards = cards(project, numbers, Set.of(CardStatus.FIXED));
        if (cards.isEmpty()) {
            return List.of();
        }
        Pool pool = pool(cycleId);
        Optional<Instant> started = lastStart(project);
        return cards.stream().map(c -> withCode(c, check(c, pool, started))).toList();
    }

    @Override
    public Optional<RetestCheck> checkCard(String cardId, String cycleId) {
        return store.find(cardId).map(c -> withCode(c, check(c, pool(cycleId), lastStart(c.project()))));
    }

    /** The card's latest code check - only one made since its fix: a look before the fix says nothing about it. */
    private RetestCheck withCode(Card card, RetestCheck check) {
        Instant fixedAt = store.lastOf(card.id(), "STATUS").map(e -> e.at()).orElse(card.updatedAt());
        return store.codeCheck(card.id()).filter(c -> !c.at().isBefore(fixedAt)).map(check::withCode).orElse(check);
    }

    private static final int MAX_LAYERS = 12;
    private static final int MAX_CODE_TEXT = 2000;

    @Override
    public CodeChange recordCode(Actor actor, String cardId, CodeIn in) {
        Optional<Card> found = store.find(cardId);
        if (found.isEmpty()) {
            return new CodeChange(CardChange.Outcome.NOT_FOUND, null, "No such card");
        }
        String verdict = in == null || in.verdict() == null ? "" : in.verdict().strip().toUpperCase(java.util.Locale.ROOT);
        if (!CodeCheck.VERDICTS.contains(verdict)) {
            return new CodeChange(CardChange.Outcome.INVALID, null, "verdict is one of " + String.join(", ", CodeCheck.VERDICTS));
        }
        List<CodeCheck.Layer> layers = in.layers() == null ? List.of() : in.layers();
        if (layers.size() > MAX_LAYERS) {
            return new CodeChange(CardChange.Outcome.INVALID, null, "At most " + MAX_LAYERS + " layers");
        }
        for (String t : java.util.Arrays.asList(in.commit(), in.branch(), in.tests(), in.note())) {
            if (t != null && t.length() > MAX_CODE_TEXT) {
                return new CodeChange(CardChange.Outcome.INVALID, null, "A code check text is at most " + MAX_CODE_TEXT + " characters");
            }
        }
        Card card = found.get();
        CodeCheck check = new CodeCheck(card.id(), card.number(), verdict, blank(in.commit()), blank(in.branch()), layers, blank(in.tests()),
                blank(in.note()), clock.instant(), actor);
        store.putCodeCheck(check);
        notifications.changed(card.project(), card.cycleId(), card.id(), "retest");
        return new CodeChange(CardChange.Outcome.OK, check, null);
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    @Override
    public List<RetestCheck> guards(String project) {
        List<Card> cards = cards(project, List.of(), Set.of(CardStatus.VERIFIED, CardStatus.DONE)).stream()
                .filter(c -> !plan(c.id()).expectations().isEmpty()).toList();
        if (cards.isEmpty()) {
            return List.of();
        }
        Pool pool = pool(null);
        return cards.stream().map(c -> {
            RetestCheck g = check(c, pool, Optional.empty());
            // accepted on a re-test that saw only empty answers: the guard says so for as long as it stands (specs/020)
            boolean onEmpty = store.retestRuns(c.id(), 1).stream().findFirst()
                    .filter(r -> g.since() == null || !r.at().isAfter(g.since()))
                    .filter(r -> r.summary() != null && r.summary().contains(EMPTY_MARK)).isPresent();
            return onEmpty ? g.withVerifiedOnEmpty() : g;
        }).toList();
    }

    @Override
    public Report run(Actor actor, String project, List<Integer> numbers, String cycleId) {
        List<RetestCheck> checks = check(project, numbers, cycleId);
        Instant at = clock.instant();
        String source = cycleId == null || cycleId.isBlank() ? "live" : "cycle:" + cycleId;
        for (RetestCheck c : checks) {
            store.findByNumber(project, c.number()).ifPresent(card -> {
                store.appendRetestRun(new RetestRun(0, card.id(), c.number(), at, actor, source, c.verdict(), c.calls().size(), c.summary()));
                notifications.changed(card.project(), card.cycleId(), card.id(), "retest");
            });
        }
        String markdown = RetestReport.markdown(project, at, source, checks, lastStart(project).orElse(null));
        if (cycleId != null && !cycleId.isBlank() && !checks.isEmpty()) {
            // The report stays with the re-test cycle, in its session log (FR-12).
            String did = "Re-tested " + checks.stream().map(c -> "#" + c.number()).collect(java.util.stream.Collectors.joining(" "));
            long passed = checks.stream().filter(c -> c.verdict() == Verdict.PASSES).count();
            String next = passed > 0 ? "Accept Verified on the " + passed + " passing " + (passed == 1 ? "card" : "cards") : "Fix what still fails";
            store.appendLog(new com.fathy.alfred.backend.board.domain.model.SessionLogEntry(0, cycleId, "re-test", did,
                    markdown.length() > com.fathy.alfred.backend.board.application.port.in.SessionLogUseCase.MAX_TEXT
                            ? markdown.substring(0, com.fathy.alfred.backend.board.application.port.in.SessionLogUseCase.MAX_TEXT) : markdown,
                    next, at));
            notifications.changed(project, cycleId, null, "log");
        }
        return new Report(at, source, checks, markdown);
    }

    @Override
    public List<RetestRun> history(String cardId) {
        return store.retestRuns(cardId, HISTORY);
    }

    @Override
    public Optional<Instant> lastStart(String project) {
        return store.appStart(project == null ? "" : project);
    }

    @Override
    public void appStarted(String project, Instant at) {
        if (project == null || project.isBlank() || at == null) {
            return;
        }
        store.putAppStart(project, at);
        notifications.changed(project, null, null, "retest");
    }

    @Override
    public void callArrived(String project, String endpoint) {
        if (endpoint == null || endpoint.isBlank()) {
            return;
        }
        try {
            watcher.execute(() -> signalWatchers(project == null ? "" : project, endpoint, true));
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // shutting down
        }
    }

    private void signalWatchers(String project, String endpoint, boolean again) {
        try {
            List<Card> watching = cards(project, List.of(), Set.of(CardStatus.FIXED, CardStatus.VERIFIED, CardStatus.DONE)).stream()
                    .filter(c -> endpoint.equals(endpointOf(c.signature()))
                            || plan(c.id()).steps().stream().anyMatch(s -> endpoint.equals(s.endpoint())))
                    .filter(c -> c.status() == CardStatus.FIXED || !plan(c.id()).expectations().isEmpty())
                    .toList();
            for (Card c : watching) {
                notifications.changed(c.project(), c.cycleId(), c.id(), "retest");
            }
            if (again && !watching.isEmpty()) {
                watcher.schedule(() -> signalWatchers(project, endpoint, false), LATE_SIGNAL_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
            }
        } catch (RuntimeException e) {
            // a failed watch costs one chip refresh, never the call
        }
    }

    @jakarta.annotation.PreDestroy
    void stopWatching() {
        watcher.shutdownNow();
    }

    private List<Card> cards(String project, List<Integer> numbers, Set<CardStatus> statuses) {
        String p = project == null ? "" : project;
        if (numbers != null && !numbers.isEmpty()) {
            List<Card> out = new ArrayList<>();
            for (Integer n : new LinkedHashSet<>(numbers)) {
                if (n != null && out.size() < MAX_CARDS) {
                    store.findByNumber(p, n).filter(c -> c.status() != CardStatus.CLOSED).ifPresent(out::add);
                }
            }
            return out;
        }
        return store.query(new CardQuery(p, null, Set.of(), statuses, Set.of(), null, false, null, 0, CardQuery.MAX_LIMIT));
    }

    /** The calls a check reads once for every card: a cycle's, or the newest live ones. */
    private Pool pool(String cycleId) {
        if (cycleId != null && !cycleId.isBlank()) {
            return new Pool(cycleId, cycleCalls.calls(cycleId, CYCLE_CALLS));
        }
        return new Pool(null, liveCalls.recent(RECENT_CALLS));
    }

    private record Pool(String cycleId, List<CycleCall> calls) {

        String ref(CycleCall c) {
            return cycleId == null ? c.liveRef() : c.ref(cycleId);
        }
    }

    private RetestCheck check(Card card, Pool pool, Optional<Instant> started) {
        RetestPlan plan = plan(card.id());
        Instant fixedAt = store.lastOf(card.id(), "STATUS").map(e -> e.at()).orElse(card.updatedAt());
        Instant since = pool.cycleId() == null ? fixedAt : null;
        // specs/020: a call made before the app start that carries the fix ran the old code - never re-test evidence
        Instant build = started.isEmpty() ? null : fixBuild(card.project(), fixedAt, started.get());
        Instant cutoff = since == null ? build : build == null || !build.isAfter(since) ? since : build;
        String endpoint = endpointOf(card.signature());
        List<StepResult> steps = new ArrayList<>();
        for (RetestPlan.Step s : plan.steps()) {
            String ep = s.endpoint() != null ? s.endpoint() : endpoint;
            steps.add(step(s, ep, pool, cutoff));
        }
        if (endpoint == null) {
            return new RetestCheck(card.number(), card.project(), card.title(), card.status(), since, Verdict.NOT_CHECKABLE, plan.expectations().isEmpty(),
                    "No call on the card - Alfred cannot tell which endpoint to watch", List.of(), List.of(), steps, false);
        }
        List<CycleCall> matched = pool.calls().stream().filter(c -> endpoint.equals(c.endpoint()) && after(c, cutoff)).limit(CALLS_PER_CARD).toList();
        int beforeBuild = build == null ? 0 : (int) pool.calls().stream()
                .filter(c -> endpoint.equals(c.endpoint()) && after(c, since) && !after(c, cutoff)).count();
        boolean newBuild = build != null && matched.isEmpty() && (since == null || build.isAfter(since));
        int empty = (int) matched.stream().filter(c -> facts.bodies(c.callId(), pool.cycleId())
                .map(b -> RequirementJudge.emptyAnswer(tree(b.responseBody()))).orElse(false)).count();

        boolean statusOnly = plan.expectations().isEmpty();
        List<Expectation> expectations = statusOnly ? List.of(new Expectation(Expectation.Kind.STATUS, null, null, okRange(card), null, null, null))
                : plan.expectations();
        Set<String> paths = new LinkedHashSet<>();
        expectations.stream().filter(e -> e.kind() == Expectation.Kind.SAME_RESPONSE).forEach(e -> paths.add(e.path()));

        Optional<CallFacts> before = original(card, paths);
        List<Optional<CallFacts>> after = matched.stream().map(c -> facts.facts(c.callId(), pool.cycleId(), paths)).toList();

        List<Result> results = new ArrayList<>();
        boolean[] failedAny = new boolean[matched.size()];
        String[] failedWhat = new String[matched.size()];
        for (Expectation e : expectations) {
            String beforeValue = before.map(f -> value(e, f, null)).orElse(null);
            List<String> values = new ArrayList<>();
            int judged = 0;
            boolean fail = false;
            String note = null;
            for (int i = 0; i < matched.size(); i++) {
                CycleCall call = matched.get(i);
                Optional<CallFacts> f = after.get(i);
                String v = f.map(x -> value(e, x, call)).orElse(null);
                values.add(v == null ? "?" : v);
                Outcome o = f.isEmpty() ? Outcome.UNKNOWN : judge(e, f.get(), call, before.orElse(null));
                if (o == Outcome.UNKNOWN) {
                    note = f.isEmpty() ? "call no longer stored" : unknownWhy(e, before.isPresent());
                    continue;
                }
                judged++;
                if (o == Outcome.FAIL) {
                    fail = true;
                    if (!failedAny[i]) {
                        failedAny[i] = true;
                        failedWhat[i] = e.text() + ": " + v;
                    }
                }
            }
            Outcome outcome = matched.isEmpty() ? Outcome.WAITING
                    : fail ? Outcome.FAIL
                    : judged == 0 ? Outcome.UNKNOWN
                    : judged < e.callsNeeded() ? Outcome.WAITING
                    : Outcome.PASS;
            if (outcome == Outcome.WAITING && !matched.isEmpty()) {
                note = judged + " / " + e.callsNeeded() + " calls";
            }
            String text = statusOnly ? "Status " + (okRange(card).startsWith("!") ? "not " + okRange(card).substring(1) : okRange(card))
                    + " (status only - no expectations)" : e.text();
            results.add(new Result(text, e, outcome, beforeValue, values, note));
        }

        List<CallResult> calls = new ArrayList<>();
        int passed = 0;
        for (int i = 0; i < matched.size(); i++) {
            CycleCall c = matched.get(i);
            if (!failedAny[i]) {
                passed++;
            }
            calls.add(new CallResult(pool.ref(c), label(c), c.at(), !failedAny[i], failedWhat[i]));
        }

        Verdict verdict;
        if (matched.isEmpty()) {
            verdict = Verdict.NO_CALLS;
        } else if (passed == 0) {
            verdict = Verdict.FAILS;
        } else if (passed < matched.size()) {
            verdict = Verdict.FLAKY;
        } else if (results.stream().anyMatch(r -> r.outcome() == Outcome.WAITING || r.outcome() == Outcome.UNKNOWN)
                || steps.stream().anyMatch(s -> !s.seen())) {
            verdict = Verdict.PARTIAL;
        } else {
            verdict = Verdict.PASSES;
        }
        String summary = summary(verdict, results, calls, steps, matched.size(), passed);
        if (!matched.isEmpty() && empty >= matched.size()) {
            summary += " · " + EMPTY_MARK + " (" + empty + (empty == 1 ? " call" : " calls") + ", 0 rows) - not seen working on data";
        }
        if (beforeBuild > 0) {
            summary = (matched.isEmpty() ? "not re-tested · no call since the fix build (app started " + build + ")" : summary)
                    + " · " + beforeBuild + (beforeBuild == 1 ? " call" : " calls") + " before the fix build not counted";
        }
        return new RetestCheck(card.number(), card.project(), card.title(), card.status(), since, verdict, statusOnly,
                summary, results, calls, steps, newBuild, beforeBuild, empty);
    }

    /**
     * The app start that carries a card's fix: the first start after the card was fixed, or - when the app was restarted
     * before the card was marked Fixed - the last start before it. Null when Alfred never saw the app start.
     */
    private Instant fixBuild(String project, Instant fixedAt, Instant latest) {
        List<Instant> starts = store.appStarts(project == null ? "" : project);
        if (starts.isEmpty()) {
            starts = List.of(latest);
        }
        if (fixedAt == null) {
            return starts.get(starts.size() - 1);
        }
        Instant before = null;
        for (Instant s : starts) {
            if (s.isAfter(fixedAt)) {
                return s;
            }
            before = s;
        }
        return before;
    }

    /** One step: done when a call to its endpoint after the cutoff sent what the step asks (specs/020). */
    private StepResult step(RetestPlan.Step s, String ep, Pool pool, Instant cutoff) {
        if (ep == null) {
            return new StepResult(s.text(), null, false, 0, null);
        }
        List<CycleCall> hits = pool.calls().stream().filter(c -> ep.equals(c.endpoint()) && after(c, cutoff)).toList();
        if (s.request().isEmpty() || hits.isEmpty()) {
            return new StepResult(s.text(), ep, !hits.isEmpty(), hits.size(), null);
        }
        int seen = 0;
        String sent = null;
        int read = 0;
        for (CycleCall c : hits) {
            if (read++ >= STEP_BODIES) {
                break;
            }
            JsonNode request = facts.bodies(c.callId(), pool.cycleId()).map(b -> tree(b.requestBody())).orElse(null);
            boolean all = true;
            for (RetestPlan.When w : s.request()) {
                Boolean holds = RequirementJudge.requestHolds(request, w.path(), w.shape());
                if (!Boolean.TRUE.equals(holds)) {
                    all = false;
                    if (sent == null) {
                        sent = w.text() + " - " + label(c) + " sent " + RequirementJudge.sentAt(request, w.path());
                    }
                    break;
                }
            }
            if (all) {
                seen++;
            }
        }
        String note = seen > 0 ? null : hits.size() + (hits.size() == 1 ? " call" : " calls")
                + " to the endpoint, none sent what the step asks: " + sent;
        return new StepResult(s.text(), ep, seen > 0, seen, note);
    }

    /** In a check's summary when every answer was empty - read back from the run history by the guard. */
    static final String EMPTY_MARK = "every answer was empty";

    /** Calls whose request a step reads, newest first. */
    static final int STEP_BODIES = 50;

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode tree(String body) {
        if (body == null || body.isBlank()) {
            return null;
        }
        try {
            return JSON.readTree(body);
        } catch (Exception e) {
            return null;
        }
    }

    /** The status a card's call should now have: not the failing class its signature names, 2xx when it was ok. */
    private static String okRange(Card card) {
        String sig = card.signature();
        String signal = sig == null || !sig.contains("|") ? "" : sig.substring(0, sig.indexOf('|'));
        return switch (signal) {
            case "5xx" -> "!5xx";
            case "4xx" -> "!4xx";
            default -> "2xx";
        };
    }

    private static boolean after(CycleCall c, Instant since) {
        return since == null || (c.at() != null && c.at().isAfter(since));
    }

    static String endpointOf(String signature) {
        return signature == null || !signature.contains("|") ? null : signature.substring(signature.indexOf('|') + 1);
    }

    /** The card's original call (its first call mention), as facts - the "before" of every expectation. */
    private Optional<CallFacts> original(Card card, Set<String> paths) {
        for (MentionRef ref : store.linksOf(card.id())) {
            if (ref.type() == MentionType.CALL && ref.ref().startsWith("in:")) {
                String r = ref.ref().substring(3);
                int at = r.indexOf('@');
                String id = at < 0 ? r : r.substring(0, at);
                String cycle = at < 0 ? null : r.substring(at + 1);
                Optional<CallFacts> f = facts.facts(id, cycle, paths);
                if (f.isPresent()) {
                    Optional<CycleCall> call = facts.call(ref.ref());
                    return Optional.of(withCall(f.get(), call.orElse(null)));
                }
                return Optional.empty();
            }
        }
        return Optional.empty();
    }

    /** Fills a fact the facts left out (status, duration) from the call itself. */
    private static CallFacts withCall(CallFacts f, CycleCall call) {
        if (call == null) {
            return f;
        }
        return new CallFacts(f.status() != null ? f.status() : call.status(), f.durationMs() != null ? f.durationMs() : call.durationMs(),
                f.statements(), f.statementsByTable(), f.errors(), f.warnings(), f.values());
    }

    private static Outcome judge(Expectation e, CallFacts f, CycleCall call, CallFacts before) {
        return switch (e.kind()) {
            case SQL_COUNT -> {
                Integer n = f.statementsOn(e.table());
                yield n == null ? Outcome.UNKNOWN : n <= e.max() ? Outcome.PASS : Outcome.FAIL;
            }
            case STATUS -> {
                Integer s = f.status() != null ? f.status() : call == null ? null : call.status();
                yield e.statusMatches(s) ? Outcome.PASS : Outcome.FAIL;
            }
            case NO_LOG -> {
                if (f.errors() == null) {
                    yield Outcome.UNKNOWN;
                }
                int n = f.errors() + (e.level().equals("WARN") && f.warnings() != null ? f.warnings() : 0);
                yield n == 0 ? Outcome.PASS : Outcome.FAIL;
            }
            case DURATION -> {
                Double d = f.durationMs() != null ? f.durationMs() : call == null ? null : call.durationMs();
                yield d == null ? Outcome.UNKNOWN : d <= e.max() ? Outcome.PASS : Outcome.FAIL;
            }
            case SAME_RESPONSE -> {
                String was = before == null ? null : before.values().get(e.path());
                if (was == null) {
                    yield Outcome.UNKNOWN;
                }
                yield was.equals(f.values().get(e.path())) ? Outcome.PASS : Outcome.FAIL;
            }
        };
    }

    /** The value an expectation reads from a call, for people: "3", "200", "0 ERROR", "410 ms", "257". */
    private static String value(Expectation e, CallFacts f, CycleCall call) {
        return switch (e.kind()) {
            case SQL_COUNT -> {
                Integer n = f.statementsOn(e.table());
                yield n == null ? null : n.toString();
            }
            case STATUS -> {
                Integer s = f.status() != null ? f.status() : call == null ? null : call.status();
                yield s == null ? "no response" : s.toString();
            }
            case NO_LOG -> {
                if (f.errors() == null) {
                    yield null;
                }
                yield e.level().equals("WARN") && f.warnings() != null ? f.errors() + " ERROR, " + f.warnings() + " WARN" : f.errors() + " ERROR";
            }
            case DURATION -> {
                Double d = f.durationMs() != null ? f.durationMs() : call == null ? null : call.durationMs();
                yield d == null ? null : Math.round(d) + " ms";
            }
            case SAME_RESPONSE -> f.values().get(e.path());
        };
    }

    private static String unknownWhy(Expectation e, boolean haveBefore) {
        return switch (e.kind()) {
            case SQL_COUNT -> "◆ database capture did not record the call";
            case NO_LOG -> "▤ log lines were not caught for the call";
            case DURATION -> "no duration recorded";
            case SAME_RESPONSE -> haveBefore ? "the original call has no value at that path" : "the original call is gone";
            case STATUS -> null;
        };
    }

    private static String summary(Verdict verdict, List<Result> results, List<CallResult> calls, List<StepResult> steps, int matched, int passed) {
        String change = results.stream().filter(r -> r.before() != null && !r.after().isEmpty() && !r.before().equals(r.after().get(0)))
                .findFirst().map(r -> r.text() + ": " + r.before() + " → " + r.after().get(0)).orElse(null);
        return switch (verdict) {
            case PASSES -> "passes · " + matched + (matched == 1 ? " call" : " calls") + " since the fix" + (change == null ? "" : " · " + change);
            case FAILS -> "fails · " + firstNonNull(calls, CallResult::failed);
            case FLAKY -> "flaky · passes " + passed + " of " + matched + " · " + firstNonNull(calls, CallResult::failed);
            case PARTIAL -> {
                String open = steps.stream().filter(s -> !s.seen()).findFirst().map(s -> s.text() + " not done yet").orElse(null);
                if (open == null) {
                    open = results.stream().filter(r -> r.outcome() == Outcome.WAITING || r.outcome() == Outcome.UNKNOWN).findFirst()
                            .map(r -> r.text() + (r.note() == null ? "" : " - " + r.note())).orElse("");
                }
                yield "partly checked · " + open;
            }
            case NO_CALLS -> "no calls since the fix" + steps.stream().findFirst().map(s -> " · " + s.text()).orElse("");
            case NOT_CHECKABLE -> "No call on the card";
        };
    }

    private static <T> String firstNonNull(List<T> list, Function<T, String> f) {
        return list.stream().map(f).filter(x -> x != null).findFirst().orElse("");
    }

    private static String label(CycleCall call) {
        String outcome = call.status() == null ? "error" : call.status().toString();
        String label = call.method() + " " + call.path() + " · " + outcome + (call.durationMs() == null ? "" : " · " + Math.round(call.durationMs()) + " ms");
        return label.length() > 200 ? label.substring(0, 199) + "…" : label;
    }
}
