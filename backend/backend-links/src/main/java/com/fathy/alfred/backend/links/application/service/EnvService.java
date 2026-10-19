package com.fathy.alfred.backend.links.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.EnvUseCase;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.StreamsUseCase;
import com.fathy.alfred.backend.links.application.port.out.EnvBoardPort;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.application.port.out.RemoteListenerPort;
import com.fathy.alfred.backend.links.domain.model.EnvAssignment;
import com.fathy.alfred.backend.links.domain.model.EnvCycle;
import com.fathy.alfred.backend.links.domain.model.EnvDef;
import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Environments (D35-D41). Marks are PASS / FAIL / CANT_TELL, ticks SEEN / FAILED, re-tests PASS / FAIL / UNKNOWN - the
 * board's own words. An environment passes when every requirement item is PASS there, no step FAILED and every Fixed
 * card's re-test is PASS; it fails on any FAIL; anything else is waited for.
 */
@Service
public class EnvService implements EnvUseCase {

    static final Set<String> MARKS = Set.of("PASS", "FAIL", "CANT_TELL");
    static final Set<String> STEP_STATES = Set.of("SEEN", "FAILED");
    static final Duration READ_WAIT = Duration.ofSeconds(15);
    static final int MAX_EVIDENCE = 20_000;

    private final LinksStorePort store;
    private final RelayService relay;
    private final StreamsService streams;
    private final PeerTransportPort transport;
    private final LinksNotificationPort notifications;
    private final ObjectProvider<EnvBoardPort> boards;
    private final ObjectProvider<RemoteListenerPort> listeners;
    private final Clock clock;

    @Autowired
    public EnvService(LinksStorePort store, RelayService relay, StreamsService streams, PeerTransportPort transport,
                      LinksNotificationPort notifications, ObjectProvider<EnvBoardPort> boards, ObjectProvider<RemoteListenerPort> listeners) {
        this(store, relay, streams, transport, notifications, boards, listeners, Clock.systemUTC());
    }

    EnvService(LinksStorePort store, RelayService relay, StreamsService streams, PeerTransportPort transport, LinksNotificationPort notifications,
               ObjectProvider<EnvBoardPort> boards, ObjectProvider<RemoteListenerPort> listeners, Clock clock) {
        this.store = store;
        this.relay = relay;
        this.streams = streams;
        this.transport = transport;
        this.notifications = notifications;
        this.boards = boards;
        this.listeners = listeners;
        this.clock = clock;
    }

    private EnvBoardPort board() {
        EnvBoardPort b = boards.getIfAvailable();
        if (b == null) {
            throw LinksProblem.conflict("UNSUPPORTED", "This Alfred has no task board");
        }
        return b;
    }

    // ------------------------------------------------------------------------------------------------------- the host

    @Override
    public List<EnvDef> envs(String boardId) {
        return store.envDefs(boardId);
    }

    @Override
    public synchronized List<EnvDef> setEnvs(String boardId, String boardName, String project, List<EnvIn> envs) {
        if (boardId == null || boardId.isBlank() || boardId.contains("@")) {
            throw LinksProblem.bad("Environments are set on this Alfred's own boards");
        }
        List<EnvIn> in = envs == null ? List.of() : envs;
        if (in.size() > 8) {
            throw LinksProblem.bad("At most 8 environments");
        }
        Set<String> names = new HashSet<>();
        boolean hostUsed = false;
        List<EnvDef> defs = new ArrayList<>();
        int ord = 0;
        for (EnvIn e : in) {
            String name = e.name() == null ? "" : e.name().trim();
            if (name.isEmpty() || name.length() > 16 || !name.matches("[A-Za-z0-9 _.-]+")) {
                throw LinksProblem.bad("An environment name of 1 to 16 letters, digits, space, '_', '.' or '-'");
            }
            if (!names.add(name.toLowerCase())) {
                throw LinksProblem.bad("Two environments named " + name);
            }
            String linkId = e.linkId() == null || e.linkId().isBlank() ? null : e.linkId();
            if (linkId == null) {
                if (hostUsed) {
                    throw LinksProblem.bad("This Alfred can do one environment of a board");
                }
                hostUsed = true;
            } else {
                Link l = store.link(linkId).filter(x -> !x.removed()).orElseThrow(() -> LinksProblem.notFound("The link for " + name));
                linkId = l.id();
            }
            defs.add(new EnvDef(boardId, name, linkId, e.required(), ord++));
        }
        Set<String> before = new LinkedHashSet<>();
        store.envDefs(boardId).stream().map(EnvDef::linkId).filter(x -> x != null).forEach(before::add);
        store.saveEnvDefs(boardId, defs);
        Set<String> now = new LinkedHashSet<>();
        defs.stream().map(EnvDef::linkId).filter(x -> x != null).forEach(now::add);
        Set<String> all = new LinkedHashSet<>(before);
        all.addAll(now);
        Instant at = clock.instant();
        for (String linkId : all) {
            List<String> theirs = defs.stream().filter(d -> linkId.equals(d.linkId())).map(EnvDef::name).toList();
            if (!theirs.isEmpty()) {
                // the environment Alfred reads the board through a stream; a view stream unless one already exists
                boolean streamed = streams.offeredTo(linkId).stream().anyMatch(s -> s.kind() == StreamKind.BOARD && s.target().equals(boardId));
                if (!streamed) {
                    streams.start(new StreamsUseCase.StreamIn(linkId, StreamKind.BOARD, boardId, boardName, project, StreamMode.VIEW, false, false,
                            StreamMode.VIEW, false, null, null));
                }
            }
            ObjectNode e = Json.MAPPER.createObjectNode();
            e.put("boardId", boardId);
            e.put("boardName", boardName);
            e.put("project", project);
            ArrayNode list = e.putArray("envs");
            theirs.forEach(list::add);
            store.enqueue(linkId, "envs", e.toString(), at);
            transport.flush(linkId);
        }
        notifications.changed("env-changed", Json.write(Map.of("boardId", boardId)));
        return defs;
    }

    @Override
    public EnvBoard board(String boardId) {
        List<EnvDef> defs = store.envDefs(boardId);
        List<EnvColumn> columns = new ArrayList<>();
        EnvBoardPort b = boards.getIfAvailable();
        EnvBoardPort.Asks asks = b == null ? new EnvBoardPort.Asks(List.of(), List.of(), List.of()) : safeAsks(b, boardId);
        List<EnvCycle> cycles = store.envCycles(null, boardId);
        for (EnvDef d : defs) {
            List<EnvCycle> theirCycles = cycles.stream().filter(c -> c.env().equals(d.name())).toList();
            if (d.linkId() == null) {
                List<EnvMark> marks = b == null ? List.of() : b.hostMarks(boardId);
                List<EnvStep> steps = b == null ? List.of() : b.hostSteps(boardId);
                List<EnvRetest> retests = b == null ? List.of() : b.hostRetests(boardId);
                columns.add(column(d, null, "This Alfred", true, true, null, marks, steps, retests, theirCycles, asks));
                continue;
            }
            Link l = store.link(d.linkId()).orElse(null);
            if (l == null || l.removed()) {
                columns.add(column(d, l, l == null ? "?" : l.name(), false, false, "No longer linked", List.of(), List.of(), List.of(),
                        theirCycles, asks));
                continue;
            }
            try {
                BlockingResponse.Whole w = relay.fetch(l.slug(), RelayRequest.get("/links/peer/env", "board=" + enc(boardId)), READ_WAIT, 8 * 1024 * 1024);
                if (w.status() >= 400) {
                    JsonNode err = Json.tree(w.text());
                    columns.add(column(d, l, l.name(), false, true, err.path("message").asText("Refused"), List.of(), List.of(), List.of(),
                            theirCycles, asks));
                    continue;
                }
                JsonNode data = Json.tree(w.text());
                columns.add(column(d, l, l.name(), false, true, null, list(data.path("marks"), EnvMark.class),
                        list(data.path("steps"), EnvStep.class), list(data.path("retests"), EnvRetest.class), theirCycles, asks));
            } catch (LinkUnavailableException e) {
                columns.add(column(d, l, l.name(), false, false, l.name() + " is offline", List.of(), List.of(), List.of(), theirCycles, asks));
            }
        }
        List<String> waiting = new ArrayList<>();
        List<String> failing = new ArrayList<>();
        for (EnvColumn c : columns) {
            if (!c.required()) {
                continue;
            }
            if ("FAIL".equals(c.verdict())) {
                failing.add(c.name());
            } else if (!"PASS".equals(c.verdict())) {
                waiting.add(c.name());
            }
        }
        String overall = columns.stream().noneMatch(EnvColumn::required) ? "NONE" : !failing.isEmpty() ? "FAIL" : !waiting.isEmpty() ? "WAITING" : "PASS";
        return new EnvBoard(boardId, columns, overall, waiting, failing, clock.instant(), asksOut(asks));
    }

    private static EnvBoardPort.Asks safeAsks(EnvBoardPort b, String boardId) {
        try {
            return b.asks(null, boardId);
        } catch (RuntimeException e) {
            return new EnvBoardPort.Asks(List.of(), List.of(), List.of());
        }
    }

    private static <T> List<T> list(JsonNode array, Class<T> type) {
        List<T> out = new ArrayList<>();
        if (array != null && array.isArray()) {
            array.forEach(n -> out.add(Json.convert(n, type)));
        }
        return out;
    }

    private EnvColumn column(EnvDef d, Link l, String alfred, boolean here, boolean online, String error, List<EnvMark> marks, List<EnvStep> steps,
                             List<EnvRetest> retests, List<EnvCycle> cycles, EnvBoardPort.Asks asks) {
        List<String> missing = new ArrayList<>();
        String verdict = verdict(asks, marks, steps, retests, online || here, missing);
        return new EnvColumn(d.name(), d.linkId(), l == null ? null : l.slug(), alfred, d.required(), here, online, error, marks, steps, retests,
                cycles, verdict, missing, asksOut(asks));
    }

    private static Asks asksOut(EnvBoardPort.Asks a) {
        return new Asks(a.items().stream().map(i -> new AskItem(i.fileName(), i.itemKey(), i.text())).toList(), a.steps(), a.fixedCards());
    }

    /** PASS, FAIL or WAITING for one environment, with what is still missing there. */
    static String verdict(EnvBoardPort.Asks asks, List<EnvMark> marks, List<EnvStep> steps, List<EnvRetest> retests, boolean readable,
                          List<String> missing) {
        if (!readable) {
            missing.add("offline");
            return "WAITING";
        }
        boolean fail = marks.stream().anyMatch(m -> "FAIL".equals(m.mark())) || steps.stream().anyMatch(s -> "FAILED".equals(s.state()))
                || retests.stream().filter(r -> asks.fixedCards().contains(r.cardNumber())).anyMatch(r -> "FAIL".equals(r.verdict()));
        for (EnvBoardPort.Item item : asks.items()) {
            boolean pass = marks.stream().anyMatch(m -> m.fileName().equals(item.fileName()) && m.itemKey().equals(item.itemKey())
                    && "PASS".equals(m.mark()));
            if (!pass) {
                missing.add("requirement " + (item.text() == null || item.text().isBlank() ? item.itemKey() : shorten(item.text())));
            }
        }
        for (String step : asks.steps()) {
            if (steps.stream().noneMatch(s -> s.stepKey().equals(step) && "SEEN".equals(s.state()))) {
                missing.add("step " + step);
            }
        }
        for (int card : asks.fixedCards()) {
            if (retests.stream().noneMatch(r -> r.cardNumber() == card && "PASS".equals(r.verdict()))) {
                missing.add("re-test #" + card);
            }
        }
        if (fail) {
            return "FAIL";
        }
        return missing.isEmpty() ? "PASS" : "WAITING";
    }

    private static String shorten(String s) {
        String t = s.strip().replaceAll("\\s+", " ");
        return t.length() > 60 ? t.substring(0, 57) + "..." : t;
    }

    private static String enc(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }

    @Override
    public EnvCycle tagCycle(String boardId, String cycleRef, String env, List<Integer> retestFor, String name) {
        boolean known = store.envDefs(boardId).stream().anyMatch(d -> d.name().equals(env));
        if (!known) {
            throw LinksProblem.bad("The board has no environment " + env);
        }
        EnvCycle c = new EnvCycle(null, boardId, cycleRef, env, name, retestFor, clock.instant());
        store.saveEnvCycle(c);
        notifications.changed("env-changed", Json.write(Map.of("boardId", boardId)));
        return c;
    }

    @Override
    public void untagCycle(String boardId, String cycleRef) {
        store.deleteEnvCycle(null, boardId, cycleRef);
        notifications.changed("env-changed", Json.write(Map.of("boardId", boardId)));
    }

    @Override
    public List<EnvCycle> cycles(String boardId) {
        return store.envCycles(null, boardId);
    }

    /** The environment Alfred recorded a test cycle for this Alfred's board: put it on the board as {@code id@slug}. */
    void envCycleArrived(Link from, String data) {
        JsonNode e = Json.tree(data);
        String boardId = e.path("boardId").asText();
        String env = e.path("env").asText();
        boolean assigned = store.envDefs(boardId).stream().anyMatch(d -> from.id().equals(d.linkId()) && d.name().equals(env));
        if (!assigned) {
            return;
        }
        String ref = e.path("cycleId").asText() + "@" + from.slug();
        List<Integer> retestFor = new ArrayList<>();
        e.path("retestFor").forEach(n -> retestFor.add(n.asInt()));
        store.saveEnvCycle(new EnvCycle(null, boardId, ref, env, e.path("name").asText(null), retestFor, clock.instant()));
        EnvBoardPort b = boards.getIfAvailable();
        if (b != null) {
            b.linkCycle(boardId, ref);
        }
        notifications.changed("env-changed", Json.write(Map.of("boardId", boardId)));
        listeners.orderedStream().forEach(l -> l.envChanged(from, boardId));
    }

    void envChangedOver(Link from, String data) {
        String boardId = Json.tree(data).path("boardId").asText();
        notifications.changed("env-changed", Json.write(Map.of("boardId", boardId, "linkId", from.id())));
        listeners.orderedStream().forEach(l -> l.envChanged(from, boardId));
    }

    // ------------------------------------------------------------------------------------------ an environment Alfred

    /** The host said which of its boards' environments this Alfred does. */
    void assigned(Link from, String data) {
        JsonNode e = Json.tree(data);
        String boardId = e.path("boardId").asText();
        List<EnvAssignment> list = new ArrayList<>();
        e.path("envs").forEach(n -> list.add(new EnvAssignment(from.id(), boardId, n.asText(), e.path("boardName").asText(null),
                e.path("project").asText(null))));
        store.saveAssignments(from.id(), boardId, list);
        notifications.changed("env-changed", Json.write(Map.of("boardId", boardId, "linkId", from.id())));
    }

    @Override
    public List<Assigned> assignments() {
        List<Assigned> out = new ArrayList<>();
        for (EnvAssignment a : store.allAssignments()) {
            Optional<Link> l = store.link(a.hostLinkId()).filter(x -> !x.removed());
            if (l.isEmpty()) {
                continue;
            }
            out.add(new Assigned(a.hostLinkId(), l.get().slug(), l.get().name(), transport.state(a.hostLinkId()).online(), a.boardId(),
                    a.boardName(), a.project(), a.env()));
        }
        return out;
    }

    private record Host(Link link, EnvAssignment assignment) {
    }

    private Host host(String hostSlug, String boardId) {
        Link l = store.linkBySlug(hostSlug).filter(x -> !x.removed()).orElseThrow(() -> LinksProblem.notFound("The link " + hostSlug));
        EnvAssignment a = store.assignments(l.id()).stream().filter(x -> x.boardId().equals(boardId)).findFirst()
                .orElseThrow(() -> LinksProblem.forbidden("NOT_ASSIGNED", l.name() + " has not given this Alfred an environment of that board"));
        return new Host(l, a);
    }

    private String actor(boolean claude) {
        return claude ? "claude" : "user";
    }

    @Override
    public EnvColumn mine(String hostSlug, String boardId) {
        Host h = host(hostSlug, boardId);
        EnvDef def = new EnvDef(boardId, h.assignment().env(), null, true, 0);
        EnvBoardPort.Asks asks;
        try {
            asks = board().asks(h.link().slug(), boardId);
        } catch (RuntimeException e) {
            asks = new EnvBoardPort.Asks(List.of(), List.of(), List.of());
        }
        return column(def, h.link(), "This Alfred", true, true, null, store.envMarks(h.link().id(), boardId), store.envSteps(h.link().id(), boardId),
                store.envRetests(h.link().id(), boardId), store.envCycles(h.link().id(), boardId), asks);
    }

    /** The peer API: the host reads this Alfred's column of one of its boards. */
    String peerData(Link from, String boardId) {
        boolean assigned = store.assignments(from.id()).stream().anyMatch(a -> a.boardId().equals(boardId));
        if (!assigned) {
            throw LinksProblem.forbidden("NOT_ASSIGNED", "This Alfred does no environment of that board");
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.set("marks", Json.MAPPER.valueToTree(store.envMarks(from.id(), boardId)));
        out.set("steps", Json.MAPPER.valueToTree(store.envSteps(from.id(), boardId)));
        out.set("retests", Json.MAPPER.valueToTree(store.envRetests(from.id(), boardId)));
        out.set("cycles", Json.MAPPER.valueToTree(store.envCycles(from.id(), boardId)));
        return out.toString();
    }

    private void changedHere(Host h) {
        transport.signal(h.link().id(), "env", Json.write(Map.of("boardId", h.assignment().boardId())));
        notifications.changed("env-changed", Json.write(Map.of("boardId", h.assignment().boardId(), "linkId", h.link().id())));
    }

    @Override
    public synchronized EnvMark mark(String hostSlug, String boardId, String fileName, String itemKey, String mark, String evidence, boolean claude) {
        Host h = host(hostSlug, boardId);
        String m = mark == null ? "" : mark.trim().toUpperCase();
        if (!MARKS.contains(m)) {
            throw LinksProblem.bad("A mark is PASS, FAIL or CANT_TELL");
        }
        if (fileName == null || fileName.isBlank() || itemKey == null || itemKey.isBlank()) {
            throw LinksProblem.bad("A mark names the requirement file and item");
        }
        String ev = evidence == null ? "" : evidence.strip();
        if (ev.length() > MAX_EVIDENCE) {
            throw LinksProblem.bad("Evidence of up to " + MAX_EVIDENCE + " characters");
        }
        Instant now = clock.instant();
        Optional<EnvMark> before = store.envMark(h.link().id(), boardId, fileName, itemKey);
        ArrayNode history = before.map(b -> (ArrayNode) Json.tree(b.history())).orElse(Json.MAPPER.createArrayNode());
        before.ifPresent(b -> {
            ObjectNode entry = history.addObject();
            entry.put("mark", b.mark());
            entry.put("actor", b.actor());
            entry.put("at", b.at() == null ? null : b.at().toString());
            entry.put("evidence", b.evidence());
        });
        while (history.size() > 50) {
            history.remove(0);
        }
        EnvMark next = new EnvMark(h.link().id(), boardId, fileName, itemKey, m, ev, actor(claude), now, history.toString());
        store.saveEnvMark(next);
        changedHere(h);
        return next;
    }

    @Override
    public void clearMark(String hostSlug, String boardId, String fileName, String itemKey) {
        Host h = host(hostSlug, boardId);
        store.deleteEnvMark(h.link().id(), boardId, fileName, itemKey);
        changedHere(h);
    }

    @Override
    public EnvStep step(String hostSlug, String boardId, String stepKey, String state, String note, boolean claude) {
        Host h = host(hostSlug, boardId);
        String s = state == null ? "" : state.trim().toUpperCase();
        if (!STEP_STATES.contains(s)) {
            throw LinksProblem.bad("A step is SEEN or FAILED");
        }
        if (stepKey == null || stepKey.isBlank()) {
            throw LinksProblem.bad("A tick names its step");
        }
        String n = note == null ? null : note.strip();
        if (n != null && n.length() > 4000) {
            throw LinksProblem.bad("A note of up to 4000 characters");
        }
        EnvStep step = new EnvStep(h.link().id(), boardId, stepKey, s, n == null || n.isEmpty() ? null : n, actor(claude), clock.instant());
        store.saveEnvStep(step);
        changedHere(h);
        return step;
    }

    @Override
    public void clearStep(String hostSlug, String boardId, String stepKey) {
        Host h = host(hostSlug, boardId);
        store.deleteEnvStep(h.link().id(), boardId, stepKey);
        changedHere(h);
    }

    @Override
    public EnvCycle record(String hostSlug, String boardId, String name, List<Integer> retestFor) {
        Host h = host(hostSlug, boardId);
        String project = h.assignment().project() == null || h.assignment().project().isBlank() ? "default" : h.assignment().project();
        String cycleName = name == null || name.isBlank()
                ? (retestFor == null || retestFor.isEmpty() ? (h.assignment().boardName() == null ? boardId : h.assignment().boardName()) + " · "
                + h.assignment().env() : retestName(retestFor, h.assignment().env()))
                : name.strip();
        String cycleId = board().startCycle(project, cycleName);
        EnvCycle c = new EnvCycle(h.link().id(), boardId, cycleId, h.assignment().env(), cycleName, retestFor, clock.instant());
        store.saveEnvCycle(c);
        // streamed to the host automatically (D38), named for its environment
        streams.start(new StreamsUseCase.StreamIn(h.link().id(), StreamKind.CYCLE, cycleId, cycleName, project, StreamMode.VIEW, false, false,
                StreamMode.VIEW, false, h.assignment().env(), boardId));
        ObjectNode e = Json.MAPPER.createObjectNode();
        e.put("boardId", boardId);
        e.put("cycleId", cycleId);
        e.put("env", h.assignment().env());
        e.put("name", cycleName);
        ArrayNode cards = e.putArray("retestFor");
        c.retestFor().forEach(cards::add);
        store.enqueue(h.link().id(), "env-cycle", e.toString(), clock.instant());
        transport.flush(h.link().id());
        changedHere(h);
        return c;
    }

    /** "Re-test #7 #9 · STG" - the same naming the host's re-test cycles use (CycleNaming), with the environment. */
    static String retestName(List<Integer> cards, String env) {
        StringBuilder b = new StringBuilder("Re-test");
        cards.stream().limit(3).forEach(n -> b.append(" #").append(n));
        if (cards.size() > 3) {
            b.append(" +").append(cards.size() - 3);
        }
        return b.append(" · ").append(env).toString();
    }

    @Override
    public synchronized List<EnvRetest> retest(String hostSlug, String boardId, List<Integer> cardNumbers, String cycleId, boolean claude) {
        Host h = host(hostSlug, boardId);
        String cycle = cycleId;
        if (cycle == null || cycle.isBlank()) {
            // the newest test cycle recorded for these cards, else the newest of this environment
            List<EnvCycle> mine = store.envCycles(h.link().id(), boardId);
            cycle = mine.stream().filter(c -> cardNumbers != null && !cardNumbers.isEmpty() && c.retestFor().containsAll(cardNumbers))
                    .reduce((a, b) -> b).or(() -> mine.stream().reduce((a, b) -> b)).map(EnvCycle::cycleRef)
                    .orElseThrow(() -> LinksProblem.bad("Record a test cycle for " + h.assignment().env() + " first"));
        }
        List<EnvBoardPort.Verdict> verdicts = board().judge(h.link().slug(), boardId, cardNumbers == null ? List.of() : cardNumbers, cycle);
        Instant now = clock.instant();
        List<EnvRetest> out = new ArrayList<>();
        for (EnvBoardPort.Verdict v : verdicts) {
            EnvRetest r = new EnvRetest(h.link().id(), boardId, v.cardNumber(), v.verdict(), v.summary(), cycle, actor(claude), now);
            store.saveEnvRetest(r);
            out.add(r);
        }
        changedHere(h);
        return out;
    }

    /** A link went away: its assignments and the board environments given to it stop counting. */
    void linkRemoved(Link l) {
        for (EnvAssignment a : store.assignments(l.id())) {
            store.saveAssignments(l.id(), a.boardId(), List.of());
        }
    }

    Optional<Stream> streamOf(String linkId, String boardId) {
        return streams.offeredTo(linkId).stream().filter(s -> s.kind() == StreamKind.BOARD && s.target().equals(boardId)).findFirst();
    }
}
