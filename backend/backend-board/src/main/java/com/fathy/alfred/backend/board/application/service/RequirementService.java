package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.CardLinksUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.LinkCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ProposeUseCase;
import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.application.port.in.RequirementWatchUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.CallFactsPort;
import com.fathy.alfred.backend.board.application.port.out.CycleCallsPort;
import com.fathy.alfred.backend.board.application.port.out.RequirementStorePort;
import com.fathy.alfred.backend.board.application.port.out.RequirementStorePort.CallRow;
import com.fathy.alfred.backend.board.domain.AcceptanceItems;
import com.fathy.alfred.backend.board.domain.EndpointPattern;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.RequirementJudge;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardRef;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.ChecklistMark;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.Verdict;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import com.fathy.alfred.backend.board.domain.model.SpecFileInfo;
import com.fathy.alfred.backend.board.domain.model.Team;
import com.fathy.alfred.backend.board.domain.model.Waiting;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * The requirement check (specs/018): every call a cycle captures to an endpoint some Acceptance item's evidence names
 * is judged once, in code ({@link RequirementJudge}); each item's verdict is the worst result among its calls since
 * the app last started or the item's card was fixed. An item the calls show is not built (MISSING) or answers wrong
 * (WRONG) gets a card at once - one card for the items one missing capability blocks - opened as Claude, so every
 * board rule for Claude still applies. Nothing here closes, marks or moves a card past what Claude may.
 * <p>
 * Cost per completed inbound call: a lookup in a small in-memory set; only a call to a watched endpoint has its cycle's
 * new calls read (bodies once, nothing kept). Its own thread - never the webhook's, never the re-test watch's.
 */
@Service
public class RequirementService implements RequirementUseCase, RequirementWatchUseCase {

    private static final Logger log = LoggerFactory.getLogger(RequirementService.class);

    /** Calls of a cycle read per judging pass - the cycle's calls come oldest first, so this is the cycle's whole length. */
    static final int CYCLE_CALLS = 20_000;
    /** Calls arriving within this window are judged in one pass per cycle (a script firing 100 calls a second costs one). */
    static final int COALESCE_MS = 500;
    static final int RESULTS = 5000;
    /** Statements, log lines and the cycle's copy of a call arrive a little after it completes: look again then. */
    static final int LATE_SIGNAL_SECONDS = 20;
    /** A call whose bodies are still not readable this long after it was made is judged UNKNOWN, not tried forever. */
    static final Duration BODY_WAIT = Duration.ofMinutes(2);
    /** Safety stop against a wrong evidence plan: cards the check may open per cycle per hour. */
    static final int CARDS_PER_HOUR = 10;
    /** Calls linked to a card per judging run. */
    static final int LINKS_PER_RUN = 10;

    private final RequirementStorePort requirements;
    private final BoardStorePort store;
    private final CycleCallsPort cycleCalls;
    private final CallFactsPort facts;
    private final CreateCardUseCase create;
    private final LinkCardUseCase link;
    private final CardLinksUseCase specLinks;
    private final CommentOnCardUseCase comments;
    private final ProposeUseCase propose;
    private final BoardNotificationPort notifications;
    private final Clock clock;
    private final ObjectMapper json = new ObjectMapper();

    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "board-requirements");
        t.setDaemon(true);
        return t;
    });
    /** "project\nendpoint" of every evidence; null = load again. */
    private volatile List<String[]> watched;
    private final Map<String, Deque<Instant>> opened = new ConcurrentHashMap<>();
    /** Judging passes already scheduled, per cycle ("now:" and "late:" + cycle id) - one each, however many calls arrive. */
    private final Set<String> scheduled = ConcurrentHashMap.newKeySet();
    private final Set<String> pauseNoted = ConcurrentHashMap.newKeySet();
    /** The last verdict seen per item ("cycle\nfile\nkey"), to say once when a carded item became met. */
    private final Map<String, Verdict> lastVerdict = new ConcurrentHashMap<>();

    @Autowired
    public RequirementService(RequirementStorePort requirements, BoardStorePort store, CycleCallsPort cycleCalls, CallFactsPort facts,
                              CreateCardUseCase create, LinkCardUseCase link, CardLinksUseCase specLinks, CommentOnCardUseCase comments,
                              ProposeUseCase propose, BoardNotificationPort notifications, BoardChangeFeed feed) {
        this(requirements, store, cycleCalls, facts, create, link, specLinks, comments, propose, feed.feeding(notifications), Clock.systemUTC());
    }

    RequirementService(RequirementStorePort requirements, BoardStorePort store, CycleCallsPort cycleCalls, CallFactsPort facts,
                       CreateCardUseCase create, LinkCardUseCase link, CardLinksUseCase specLinks, CommentOnCardUseCase comments,
                       ProposeUseCase propose, BoardNotificationPort notifications, Clock clock) {
        this.requirements = requirements;
        this.store = store;
        this.cycleCalls = cycleCalls;
        this.facts = facts;
        this.create = create;
        this.link = link;
        this.specLinks = specLinks;
        this.comments = comments;
        this.propose = propose;
        this.notifications = notifications;
        this.clock = clock;
    }

    /** Boards (specs/027): only an open board judges, and it judges its project's live calls too. Optional for tests. */
    private com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort boardModel;
    private com.fathy.alfred.backend.board.application.port.out.LiveCallsPort liveCalls;
    /** The live (not captured) calls of the judging pass under way - judgeCycle is synchronized, act() runs inside it. */
    private volatile Set<String> judgingLive = Set.of();
    /** How many of the newest live calls an open board looks at per pass. */
    static final int LIVE_CALLS = 500;

    @Autowired(required = false)
    void setBoards(com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort boardModel,
                   com.fathy.alfred.backend.board.application.port.out.LiveCallsPort liveCalls) {
        this.boardModel = boardModel;
        this.liveCalls = liveCalls;
    }

    @jakarta.annotation.PreDestroy
    void stop() {
        worker.shutdownNow();
    }

    // ----------------------------------------------------------------------------------------------------- evidence

    @Override
    public List<ItemEvidence> evidence(String cycleId) {
        return requirements.evidence(cycleId);
    }

    @Override
    public EvidenceChange putEvidence(Actor actor, ItemEvidence in) {
        if (in == null || in.cycleId() == null || in.fileName() == null || in.itemKey() == null) {
            return new EvidenceChange(CardChange.Outcome.INVALID, null, "cycleId, fileName and itemKey are required");
        }
        String problem = in.problem();
        if (problem != null) {
            return new EvidenceChange(CardChange.Outcome.INVALID, null, problem);
        }
        if (itemText(in.cycleId(), in.fileName(), in.itemKey()) == null) {
            return new EvidenceChange(CardChange.Outcome.NOT_FOUND, null, "No acceptance item " + in.itemKey() + " in " + in.fileName());
        }
        if (actor == Actor.CLAUDE) {
            Optional<ItemEvidence> before = requirements.evidence(in.cycleId(), in.fileName(), in.itemKey());
            if (before.isPresent() && before.get().updatedBy() == Actor.USER) {
                return new EvidenceChange(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, "The user wrote this item's evidence - only the user changes it");
            }
        }
        ItemEvidence saved = new ItemEvidence(in.cycleId(), in.fileName(), in.itemKey(), in.project(), in.endpoint(), in.checks(), in.howTo(),
                actor, clock.instant());
        requirements.putEvidence(saved);
        lastVerdict.remove(itemId(saved.cycleId(), saved.fileName(), saved.itemKey()));
        watched = null;
        later(() -> judgeCycle(saved.cycleId()));
        notifications.changed(saved.project(), saved.cycleId(), null, "requirements");
        return new EvidenceChange(CardChange.Outcome.OK, saved, null);
    }

    @Override
    public EvidenceChange deleteEvidence(Actor actor, String cycleId, String fileName, String itemKey) {
        if (actor == Actor.CLAUDE) {
            return new EvidenceChange(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, "Only the user deletes an item's evidence");
        }
        Optional<ItemEvidence> before = requirements.evidence(cycleId, fileName, itemKey);
        if (!requirements.deleteEvidence(cycleId, fileName, itemKey)) {
            return new EvidenceChange(CardChange.Outcome.NOT_FOUND, null, "No evidence for that item");
        }
        watched = null;
        notifications.changed(before.map(ItemEvidence::project).orElse(null), cycleId, null, "requirements");
        return new EvidenceChange(CardChange.Outcome.OK, null, null);
    }

    // ---------------------------------------------------------------------------------------------------- the watch

    @Override
    public void callArrived(String project, String endpoint) {
        if (endpoint == null || endpoint.isBlank()) {
            return;
        }
        later(() -> onCall(project == null ? "" : project, endpoint));
    }

    private void later(Runnable task) {
        try {
            worker.execute(() -> {
                try {
                    task.run();
                } catch (RuntimeException e) {
                    log.warn("Requirement check failed: {}", e.toString());
                }
            });
        } catch (RejectedExecutionException e) {
            // shutting down
        }
    }

    private void onCall(String project, String endpoint) {
        Set<String> cycles = new HashSet<>();
        for (String[] w : watched()) {
            if ((w[0].isEmpty() || w[0].equals(project)) && EndpointPattern.matches(w[1], endpoint)) {
                for (ItemEvidence e : requirements.evidenceFor(w[0], w[1])) {
                    cycles.add(e.cycleId());
                }
            }
        }
        for (String cycleId : cycles) {
            judgeSoon("now:", cycleId, COALESCE_MS);
            // the cycle's copy of a call, its statements and log lines come a little later: one more pass then
            judgeSoon("late:", cycleId, LATE_SIGNAL_SECONDS * 1000L);
        }
    }

    /** One judging pass of the cycle after {@code delayMs}, unless one of this kind is already waiting. */
    private void judgeSoon(String kind, String cycleId, long delayMs) {
        String key = kind + cycleId;
        if (!scheduled.add(key)) {
            return;
        }
        try {
            worker.schedule(() -> {
                scheduled.remove(key);
                try {
                    judgeCycle(cycleId);
                } catch (RuntimeException e) {
                    log.warn("Requirement check failed for {}: {}", cycleId, e.toString());
                }
            }, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            scheduled.remove(key); // shutting down
        }
    }

    private List<String[]> watched() {
        List<String[]> w = watched;
        if (w == null) {
            w = new ArrayList<>();
            for (String pe : requirements.watchedEndpoints()) {
                int nl = pe.indexOf('\n');
                if (nl >= 0) {
                    w.add(new String[] {pe.substring(0, nl), pe.substring(nl + 1)});
                }
            }
            watched = w;
        }
        return w;
    }

    // ------------------------------------------------------------------------------------------------------ judging

    /** Judges the cycle's calls not judged yet, then acts on the verdicts that call for a card. One cycle at a time. */
    synchronized void judgeCycle(String cycleId) {
        judgingLive = Set.of(); // never the last pass's live calls, whatever this one returns early on
        List<ItemEvidence> all = requirements.evidence(cycleId).stream().filter(e -> !e.manual() && e.problem() == null).toList();
        if (all.isEmpty()) {
            return;
        }
        var board = boardModel == null ? java.util.Optional.<com.fathy.alfred.backend.board.domain.model.Board>empty() : boardModel.board(cycleId);
        if (board.isPresent() && !board.get().open()) {
            return; // a done or archived board judges no new calls (FR-001a)
        }
        List<CycleCall> calls = new ArrayList<>(cycleCalls.calls(cycleId, CYCLE_CALLS).stream().filter(c -> "in".equals(c.direction())).toList());
        // An open board also judges its project's live calls (FR-005, clarified 2026-10-17); their bodies are read live.
        Set<String> live = new HashSet<>();
        judgingLive = live;
        if (board.isPresent() && liveCalls != null) {
            Set<String> captured = new HashSet<>(calls.stream().map(CycleCall::callId).toList());
            for (CycleCall c : liveCalls.recentOf(board.get().project(), LIVE_CALLS)) {
                if ("in".equals(c.direction()) && captured.add(c.callId())) {
                    calls.add(c);
                    live.add(c.callId());
                }
            }
        }
        Map<String, Parsed> bodies = new HashMap<>();
        Map<String, List<CallRow>> fresh = new LinkedHashMap<>();
        boolean changed = false;
        for (ItemEvidence ev : all) {
            Set<String> judged = requirements.judgedCalls(cycleId, ev.fileName(), ev.itemKey());
            List<CallRow> rows = new ArrayList<>();
            for (CycleCall c : calls) {
                if (judged.contains(c.callId()) || !EndpointPattern.matches(ev.endpoint(), c.method() + " " + c.endpoint().replaceFirst("^\\S+\\s+", ""))) {
                    continue;
                }
                Parsed p = bodies.computeIfAbsent(c.callId(), id -> parse(id, live.contains(id) ? null : cycleId));
                Instant at = c.at() == null ? clock.instant() : c.at();
                if (p == null) {
                    if (Duration.between(at, clock.instant()).compareTo(BODY_WAIT) < 0) {
                        continue; // its bodies may still be on the way: the late signal looks again
                    }
                    rows.add(new CallRow(c.callId(), CallResult.UNKNOWN, "the call's bodies could not be read", at));
                    continue;
                }
                RequirementJudge.Judgement j = RequirementJudge.judge(ev.checks(), p.request, p.response, p.status);
                rows.add(j == null ? new CallRow(c.callId(), CallResult.SKIPPED, null, at) : new CallRow(c.callId(), j.result(), j.reason(), at));
            }
            if (!rows.isEmpty()) {
                requirements.putResults(cycleId, ev.fileName(), ev.itemKey(), rows);
                fresh.put(itemId(cycleId, ev.fileName(), ev.itemKey()), rows);
                changed = true;
            }
        }
        if (changed) {
            act(cycleId, all, calls, fresh);
            notifications.changed(all.get(0).project(), cycleId, null, "requirements");
        }
    }

    private record Parsed(Integer status, JsonNode request, JsonNode response) {
    }

    private Parsed parse(String callId, String cycleId) {
        Optional<CallFactsPort.CallBodies> b = facts.bodies(callId, cycleId);
        if (b.isEmpty()) {
            return null;
        }
        return new Parsed(b.get().status(), tree(b.get().requestBody()), tree(b.get().responseBody()));
    }

    private JsonNode tree(String body) {
        if (body == null || body.isBlank()) {
            return null;
        }
        String t = body.strip();
        if (!(t.startsWith("{") || t.startsWith("["))) {
            return null;
        }
        try {
            return json.readTree(t);
        } catch (Exception e) {
            return null;
        }
    }

    /** The item's verdict now: the worst result among its calls since the app last started (or its card was fixed). */
    ItemVerdict verdict(ItemEvidence ev, Instant newestCall, Map<String, List<CardRef>> cards) {
        if (ev.manual()) {
            return new ItemVerdict(ev.cycleId(), ev.fileName(), ev.itemKey(), Verdict.MANUAL, null, null, ItemVerdict.Counts.NONE, null, null);
        }
        Instant since = windowStart(ev, newestCall, cards.getOrDefault(ev.fileName() + "\n" + ev.itemKey(), List.of()));
        List<CallRow> all = requirements.results(ev.cycleId(), ev.fileName(), ev.itemKey(), since, RESULTS);
        List<CallRow> rows = all.stream().filter(r -> r.result() != CallResult.SKIPPED).toList();
        int skipped = all.size() - rows.size();
        int[] n = new int[CallResult.values().length];
        for (CallRow r : rows) {
            n[r.result().ordinal()]++;
        }
        ItemVerdict.Counts counts = new ItemVerdict.Counts(n[CallResult.CONTRADICTS.ordinal()], n[CallResult.WRONG.ordinal()],
                n[CallResult.MEETS.ordinal()], n[CallResult.NO_DATA.ordinal()], n[CallResult.UNKNOWN.ordinal()], skipped);
        for (CallResult worst : List.of(CallResult.CONTRADICTS, CallResult.WRONG, CallResult.MEETS, CallResult.NO_DATA, CallResult.UNKNOWN)) {
            Optional<CallRow> deciding = rows.stream().filter(r -> r.result() == worst).findFirst(); // newest first
            if (deciding.isPresent()) {
                return new ItemVerdict(ev.cycleId(), ev.fileName(), ev.itemKey(), worst.verdict(), deciding.get().callId(),
                        deciding.get().reason(), counts, null, deciding.get().at());
            }
        }
        return new ItemVerdict(ev.cycleId(), ev.fileName(), ev.itemKey(), Verdict.NOT_EXERCISED, null, null, counts, null, null);
    }

    /**
     * Calls before this do not count: the project's last app start when the cycle has calls after it (a new build -
     * the old code's calls are history), and the last status change of a Fixed card about the item.
     */
    private Instant windowStart(ItemEvidence ev, Instant newestCall, List<CardRef> cards) {
        Instant since = null;
        Optional<Instant> started = store.appStart(ev.project());
        if (started.isPresent() && newestCall != null && !started.get().isAfter(newestCall)) {
            since = started.get();
        }
        for (CardRef ref : cards) {
            if (ref.status() != CardStatus.FIXED) {
                continue;
            }
            Optional<Card> card = store.findByNumber(ref.project(), ref.number());
            Optional<Instant> fixed = card.flatMap(c -> store.lastOf(c.id(), "STATUS").map(e -> e.at()));
            if (fixed.isPresent() && (since == null || fixed.get().isAfter(since))) {
                since = fixed.get();
            }
        }
        return since;
    }

    // ------------------------------------------------------------------------------------------------------- cards

    private void act(String cycleId, List<ItemEvidence> all, List<CycleCall> calls, Map<String, List<CallRow>> fresh) {
        Instant newest = calls.stream().map(CycleCall::at).filter(Objects::nonNull).max(Comparator.naturalOrder()).orElse(null);
        Map<String, List<CardRef>> cards = store.cardsBySpecItem(cycleId);
        Map<String, String> openedBy = requirements.openedCards(cycleId);
        Map<String, CycleCall> callById = new HashMap<>();
        calls.forEach(c -> callById.put(c.callId(), c));
        // items that need a new card, grouped: same result, same deciding call, same failing check
        Map<String, List<ItemVerdict>> groups = new LinkedHashMap<>();
        Map<String, ItemEvidence> evidenceOf = new HashMap<>();
        Map<String, Verdict> now = new HashMap<>();
        Map<String, List<CallRow>> toLink = new LinkedHashMap<>();
        Map<String, List<ItemVerdict>> metByCard = new LinkedHashMap<>();
        Map<String, Card> cardById = new HashMap<>();
        for (ItemEvidence ev : all) {
            String id = itemId(cycleId, ev.fileName(), ev.itemKey());
            evidenceOf.put(id, ev);
            ItemVerdict v = verdict(ev, newest, cards);
            Verdict before = lastVerdict.put(id, v.verdict());
            String key = ev.fileName() + "\n" + ev.itemKey();
            now.put(key, v.verdict());
            List<CardRef> about = cards.getOrDefault(key, List.of());
            Optional<Card> mine = Optional.ofNullable(openedBy.get(key)).flatMap(store::find);
            mine.ifPresent(c -> cardById.put(c.id(), c));
            boolean mineOpen = mine.isPresent() && mine.get().status() != CardStatus.CLOSED;
            if (v.verdict() == Verdict.MISSING || v.verdict() == Verdict.WRONG) {
                if (dismissed(about)) {
                    continue; // the user closed a card about this item as Fine / Not in this flow: never again
                }
                if (mineOpen) {
                    toLink.computeIfAbsent(mine.get().id(), k -> new ArrayList<>()).addAll(fresh.getOrDefault(id, List.of()));
                    continue;
                }
                if (mine.isPresent() || about.stream().anyMatch(c -> c.status() != CardStatus.CLOSED)) {
                    continue; // closed by the user (not dismissed), or another open card is about it already
                }
                String failing = v.reason() == null ? "" : v.reason().replaceFirst(" - .*$", "");
                groups.computeIfAbsent(v.verdict() + "\n" + v.callId() + "\n" + failing, k -> new ArrayList<>()).add(v);
            } else if (v.verdict() == Verdict.MET && before != null && before != Verdict.MET && mineOpen) {
                metByCard.computeIfAbsent(mine.get().id(), k -> new ArrayList<>()).add(v);
            }
        }
        toLink.forEach((cardId, rows) -> linkCalls(cardById.get(cardId), cycleId, rows, callById));
        metByCard.forEach((cardId, met) -> {
            List<String> stillOpen = openedBy.entrySet().stream().filter(e -> e.getValue().equals(cardId))
                    .map(Map.Entry::getKey).filter(k -> now.getOrDefault(k, Verdict.NOT_EXERCISED) != Verdict.MET).toList();
            nowMet(cardById.get(cardId), met, stillOpen.size(), callById, cycleId);
        });
        for (List<ItemVerdict> group : groups.values()) {
            if (!allowCard(cycleId, evidenceOf.get(itemId(cycleId, group.get(0).fileName(), group.get(0).itemKey())).project())) {
                break;
            }
            openCard(cycleId, group, evidenceOf, callById, fresh);
        }
    }

    private boolean dismissed(List<CardRef> about) {
        for (CardRef ref : about) {
            if (ref.status() == CardStatus.CLOSED) {
                Optional<Card> c = store.findByNumber(ref.project(), ref.number());
                if (c.isPresent() && (c.get().resolution() == Resolution.FINE || c.get().resolution() == Resolution.NOT_IN_FLOW)) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean allowCard(String cycleId, String project) {
        Instant now = clock.instant();
        Deque<Instant> times = opened.computeIfAbsent(cycleId, k -> new ArrayDeque<>());
        synchronized (times) {
            while (!times.isEmpty() && times.peekFirst().isBefore(now.minus(Duration.ofHours(1)))) {
                times.pollFirst();
            }
            if (times.size() < CARDS_PER_HOUR) {
                return true;
            }
        }
        if (pauseNoted.add(cycleId)) {
            create.create(Actor.CLAUDE, new CreateCardUseCase.NewCard(project, CardKind.NOTE,
                    "Requirement check paused: too many missing items in an hour",
                    "**The requirement check opened " + CARDS_PER_HOUR + " cards for this cycle within an hour and stopped opening more.**\n\n"
                            + "> Usually the evidence of some items is wrong (a field name, an endpoint).\n\n### Next\n"
                            + "Check the items' evidence on the Task tab; the check opens cards again after an hour.",
                    null, cycleId, CardStatus.INBOX, List.of()));
        }
        return false;
    }

    private void openCard(String cycleId, List<ItemVerdict> group, Map<String, ItemEvidence> evidenceOf, Map<String, CycleCall> callById,
                          Map<String, List<CallRow>> fresh) {
        ItemVerdict first = group.get(0);
        ItemEvidence ev = evidenceOf.get(itemId(cycleId, first.fileName(), first.itemKey()));
        boolean missing = first.verdict() == Verdict.MISSING;
        List<String> texts = group.stream().map(v -> itemText(cycleId, v.fileName(), v.itemKey())).filter(Objects::nonNull).toList();
        if (texts.isEmpty()) {
            return;
        }
        String shortest = texts.stream().min(Comparator.comparingInt(String::length)).orElse(texts.get(0));
        String title = (missing ? "Missing feature: " : "Wrong result: ") + clip(trimDot(shortest), 160)
                + (texts.size() > 1 ? " (and " + (texts.size() - 1) + " more)" : "");
        CycleCall call = callById.get(first.callId());
        String callLabel = call == null ? "call " + shortId(first.callId()) : call.method() + " " + call.path() + " · " + call.status();
        String check = first.reason() == null ? "" : first.reason();
        StringBuilder d = new StringBuilder();
        d.append("**").append(missing
                        ? "The calls show " + (texts.size() == 1 ? "this Acceptance item is" : "these " + texts.size() + " Acceptance items are") + " not built: "
                        : "The answer breaks " + (texts.size() == 1 ? "this Acceptance item" : "these Acceptance items") + ": ")
                .append(escape(check)).append(".**\n\n");
        d.append("> ").append(escape(callLabel)).append(" · ").append(texts.size()).append(texts.size() == 1 ? " item" : " items")
                .append(" · found by Alfred's requirement check (no model)\n\n");
        d.append("### Acceptance items\n");
        for (ItemVerdict v : group) {
            String t = itemText(cycleId, v.fileName(), v.itemKey());
            if (t != null) {
                d.append("- ").append(MentionParser.serialize(new MentionRef(MentionType.SPEC, cycleId + "/" + v.fileName(), clip(t, 100))))
                        .append('\n');
            }
        }
        d.append("\n### Evidence\n- The linked call: ").append(escape(callLabel)).append("\n- What it needs: ")
                .append(escape(ev == null ? "" : ev.checks().stream().filter(c -> c.kind().name().startsWith("REQUEST") || !missing)
                        .map(c -> c.text()).reduce((a, b) -> a + "; " + b).orElse(""))).append("\n");
        if (ev != null && !ev.howTo().isEmpty()) {
            d.append("- How to exercise it: ").append(escape(ev.howTo())).append('\n');
        }
        d.append("\n### Next\n").append(missing
                ? "Build what the items ask for (the request must be able to carry it), then use the page again - the check re-judges every new call."
                : "Fix the answer for these requests, then use the page again - the check re-judges every new call.");
        CardChange made = create.create(Actor.CLAUDE, new CreateCardUseCase.NewCard(ev == null ? "" : ev.project(),
                missing ? CardKind.TASK : CardKind.BUG, title, d.toString(), null, cycleId, CardStatus.INBOX, List.of(),
                teams(missing)));
        if (made.outcome() != CardChange.Outcome.OK || made.card() == null) {
            log.info("Requirement check: no card for {} item(s) of cycle {}: {}", texts.size(), cycleId, made.message());
            return;
        }
        Deque<Instant> times = opened.computeIfAbsent(cycleId, k -> new ArrayDeque<>());
        synchronized (times) {
            times.addLast(clock.instant());
        }
        Card card = made.card().card();
        if (call != null) {
            link.link(Actor.CLAUDE, card.id(), callRef(call, cycleId));
        }
        for (ItemVerdict v : group) {
            specLinks.linkSpecItem(Actor.CLAUDE, card.id(), cycleId, v.fileName(), v.itemKey());
            requirements.putOpenedCard(cycleId, v.fileName(), v.itemKey(), card.id());
        }
        List<CallRow> more = group.stream().flatMap(v -> fresh.getOrDefault(itemId(cycleId, v.fileName(), v.itemKey()), List.of()).stream())
                .filter(r -> r.result() == (missing ? CallResult.CONTRADICTS : CallResult.WRONG) && !r.callId().equals(first.callId())).toList();
        linkCalls(card, cycleId, more, callById);
        String mention = call == null ? "call " + shortId(first.callId()) : MentionParser.serialize(callRef(call, cycleId));
        comments.comment(Actor.CLAUDE, card.id(), new CommentOnCardUseCase.Comment(null,
                "Alfred's requirement check judged " + mention + " against the evidence of " + texts.size()
                        + (texts.size() == 1 ? " Acceptance item" : " Acceptance items") + " (in code, no model).",
                escape(check) + ".",
                missing ? "Waiting on the developer: build it, then use the page again - each new call is judged as it arrives."
                        : "Waiting on the developer: fix the answer, then use the page again.",
                null, null, null, null, false, Waiting.USER));
    }

    private void linkCalls(Card card, String cycleId, List<CallRow> rows, Map<String, CycleCall> callById) {
        CallResult wanted = card.kind() == CardKind.BUG ? CallResult.WRONG : CallResult.CONTRADICTS;
        Set<String> done = new HashSet<>();
        for (CallRow r : rows) {
            if (done.size() >= LINKS_PER_RUN) {
                break;
            }
            CycleCall c = callById.get(r.callId());
            if (r.result() == wanted && c != null && done.add(r.callId())) {
                link.link(Actor.CLAUDE, card.id(), callRef(c, cycleId));
            }
        }
    }

    /** Items of a card the check opened that the calls now show met: one comment, or a proposal once all are met. */
    private void nowMet(Card card, List<ItemVerdict> met, int stillOpen, Map<String, CycleCall> callById, String cycleId) {
        ItemVerdict first = met.get(0);
        CycleCall call = callById.get(first.callId());
        String mention = call == null ? "call " + shortId(first.callId()) : MentionParser.serialize(callRef(call, cycleId));
        String what = met.stream().map(v -> itemText(cycleId, v.fileName(), v.itemKey())).filter(Objects::nonNull)
                .map(t -> "\"" + escape(clip(t, 100)) + "\"").reduce((a, b) -> a + ", " + b).orElse("the items");
        if (stillOpen == 0 && (card.status() == CardStatus.FIXED || card.status() == CardStatus.VERIFIED)) {
            propose.propose(Actor.CLAUDE, card.id(), card.status() == CardStatus.FIXED ? CardStatus.VERIFIED : CardStatus.DONE, null,
                    "The requirement check finds every item of this card met.", "Met by " + mention + ": " + what + ".");
            return;
        }
        comments.comment(Actor.CLAUDE, card.id(), new CommentOnCardUseCase.Comment(null,
                "The requirement check judged " + mention + ".",
                what + (met.size() == 1 ? " is" : " are") + " now met by the calls"
                        + (stillOpen == 0 ? " - every item of this card is." : "; " + stillOpen + (stillOpen == 1 ? " item is" : " items are") + " not yet."),
                stillOpen == 0 ? "Waiting on you: move the card on (Fixed, then Verified)." : "Waiting on the developer: the items not met yet.",
                null, null, null, null, false, Waiting.USER));
    }

    private List<String> teams(boolean missing) {
        List<String> names = missing ? List.of("backend", "frontend") : List.of("backend");
        List<String> ids = new ArrayList<>();
        try {
            for (Team t : store.teams()) {
                if (names.contains(t.name().strip().toLowerCase(Locale.ROOT))) {
                    ids.add(t.id());
                }
            }
        } catch (RuntimeException e) {
            return null;
        }
        return ids.isEmpty() ? null : ids;
    }

    /**
     * A judged call as a mention: in the cycle the task key names, or - for a board whose id is not one of its cycles
     * (specs/027) - by its live id, which every cycle's copy of it shares.
     */
    private MentionRef callRef(CycleCall c, String cycleId) {
        String label = clip(c.method() + " " + c.path() + " · " + c.status(), 120);
        boolean keyIsCycle = boardModel == null || boardModel.board(cycleId).isEmpty() || boardModel.cyclesOf(cycleId).contains(cycleId);
        String ref = keyIsCycle && !judgingLive.contains(c.callId()) ? "in:" + c.callId() + "@" + cycleId
                : cycleCalls.remoteRef(cycleId, c).orElse(c.liveRef());
        return new MentionRef(MentionType.CALL, ref, label);
    }

    // ------------------------------------------------------------------------------------------------- the view

    @Override
    public Requirements requirements(String cycleId) {
        try {
            judgeCycle(cycleId);
        } catch (RuntimeException e) {
            log.warn("Requirement check failed for {}: {}", cycleId, e.toString());
        }
        Map<String, ItemEvidence> evidence = new HashMap<>();
        for (ItemEvidence e : requirements.evidence(cycleId)) {
            evidence.put(e.fileName() + "\n" + e.itemKey(), e);
        }
        Map<String, ChecklistMark> marks = new HashMap<>();
        for (ChecklistMark m : store.marks(cycleId)) {
            marks.put(m.fileName() + "\n" + m.itemKey(), m);
        }
        Map<String, List<CardRef>> cards = store.cardsBySpecItem(cycleId);
        Map<String, String> openedBy = requirements.openedCards(cycleId);
        Instant newest = evidence.isEmpty() ? null : cycleCalls.calls(cycleId, CYCLE_CALLS).stream().map(CycleCall::at)
                .filter(Objects::nonNull).max(Comparator.naturalOrder()).orElse(null);
        List<Requirement> items = new ArrayList<>();
        Map<Verdict, Integer> counts = new EnumMap<>(Verdict.class);
        Map<String, List<AcceptanceItems.Item>> byFile = new LinkedHashMap<>();
        for (SpecFileInfo info : store.specs(cycleId)) {
            store.spec(cycleId, info.name()).ifPresent(f -> byFile.put(info.name(), AcceptanceItems.of(f.content())));
        }
        Map<String, String> shortNames = store.shortNames("item", byFile.entrySet().stream()
                .flatMap(e -> e.getValue().stream().map(i -> itemOwner(cycleId, e.getKey(), i.key()))).toList());
        for (Map.Entry<String, List<AcceptanceItems.Item>> fileItems : byFile.entrySet()) {
            String fileName = fileItems.getKey();
            for (AcceptanceItems.Item item : fileItems.getValue()) {
                String key = fileName + "\n" + item.key();
                ItemEvidence ev = evidence.get(key);
                ItemVerdict v = ev == null
                        ? new ItemVerdict(cycleId, fileName, item.key(), Verdict.NO_EVIDENCE, null, null, ItemVerdict.Counts.NONE, null, null)
                        : verdict(ev, newest, cards);
                CardRef card = cardFor(key, cards);
                ItemVerdict shown = new ItemVerdict(v.cycleId(), v.fileName(), v.itemKey(), v.verdict(), v.callId(), v.reason(), v.counts(),
                        openedBy.get(key), v.judgedAt());
                counts.merge(v.verdict(), 1, Integer::sum);
                ChecklistMark mark = marks.get(key);
                items.add(new Requirement(fileName, item.key(), item.text(), mark == null ? null : mark.mark().name(), ev, shown,
                        card == null ? null : card.number(), card == null ? null : card.status().name(),
                        shortNames.get(itemOwner(cycleId, fileName, item.key()))));
            }
        }
        return new Requirements(cycleId, items, counts);
    }

    private static String itemOwner(String cycleId, String fileName, String itemKey) {
        return cycleId + "/" + fileName + "/" + itemKey;
    }

    @Override
    public List<ItemCall> itemCalls(String cycleId, String fileName, String itemKey, int limit) {
        // The calls the verdict counts: the same window (since the app last started, or the item's card was fixed)
        Instant since = requirements.evidence(cycleId, fileName, itemKey).map(ev -> {
            Instant newest = cycleCalls.calls(cycleId, CYCLE_CALLS).stream().map(CycleCall::at).filter(Objects::nonNull)
                    .max(Comparator.naturalOrder()).orElse(null);
            return windowStart(ev, newest, store.cardsBySpecItem(cycleId).getOrDefault(fileName + "\n" + itemKey, List.of()));
        }).orElse(null);
        return requirements.results(cycleId, fileName, itemKey, since, Math.max(1, Math.min(limit, 200))).stream()
                .map(r -> new ItemCall(r.callId(), r.result(), r.reason(), r.at())).toList();
    }

    @Override
    public NameChange setShortName(Actor actor, String cycleId, String fileName, String itemKey, String shortName) {
        synchronized (shortNameLock) { // its own lock: judgeCycle holds this service's monitor for as long as judging takes
            return nameItem(actor, cycleId, fileName, itemKey, shortName);
        }
    }

    private final Object shortNameLock = new Object();

    private NameChange nameItem(Actor actor, String cycleId, String fileName, String itemKey, String shortName) {
        if (itemText(cycleId, fileName, itemKey) == null) {
            return new NameChange(CardChange.Outcome.NOT_FOUND, "No such Acceptance item");
        }
        String name = shortName == null ? "" : shortName.strip().replaceAll("\\s+", " ");
        if (name.length() > com.fathy.alfred.backend.board.application.port.in.ShortNameUseCase.MAX_SHORT_NAME) {
            return new NameChange(CardChange.Outcome.INVALID, "A short name is a few words - at most " + com.fathy.alfred.backend.board.application.port.in.ShortNameUseCase.MAX_SHORT_NAME + " characters");
        }
        if (name.contains("|") || name.contains("]")) {
            return new NameChange(CardChange.Outcome.INVALID, "A short name cannot hold | or ]");
        }
        String owner = itemOwner(cycleId, fileName, itemKey);
        if (actor == Actor.CLAUDE && store.shortNames("item", List.of(owner)).containsKey(owner)) {
            return new NameChange(CardChange.Outcome.REFUSED_FOR_CLAUDE, "This item already has a short name - only the user changes it");
        }
        store.putShortName("item", owner, name);
        notifications.changed(null, cycleId, null, "requirements");
        return new NameChange(CardChange.Outcome.OK, null);
    }

    /** The card shown for an item: the first open card about it, else the newest closed one. */
    private static CardRef cardFor(String key, Map<String, List<CardRef>> cards) {
        List<CardRef> about = cards.getOrDefault(key, List.of());
        if (about.isEmpty()) {
            return null;
        }
        return about.stream().filter(c -> c.status() != CardStatus.CLOSED).findFirst().orElse(about.get(about.size() - 1));
    }

    // -------------------------------------------------------------------------------------------------------- text

    private String itemText(String cycleId, String fileName, String itemKey) {
        return store.spec(cycleId, fileName).flatMap(f -> AcceptanceItems.of(f.content()).stream()
                .filter(i -> i.key().equals(itemKey)).findFirst()).map(AcceptanceItems.Item::text).orElse(null);
    }

    private static String itemId(String cycleId, String fileName, String itemKey) {
        return cycleId + "\n" + fileName + "\n" + itemKey;
    }

    private static String shortId(String id) {
        return id == null ? "?" : id.length() > 8 ? id.substring(0, 8) : id;
    }

    private static String trimDot(String s) {
        return s.endsWith(".") ? s.substring(0, s.length() - 1) : s;
    }

    private static String clip(String s, int max) {
        return s.length() > max ? s.substring(0, max - 1) + "…" : s;
    }

    /** Text from a request or a spec, safe inside board text: no mention or markup opening by accident. */
    private static String escape(String s) {
        return clip(s.replace("@[", "@\u200B[").replace("\n", " "), 600);
    }
}
