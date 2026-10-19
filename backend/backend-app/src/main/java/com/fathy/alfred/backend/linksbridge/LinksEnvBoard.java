package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.QueryCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.application.port.in.RetestUseCase;
import com.fathy.alfred.backend.board.application.port.in.TestStepsUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CardSummary;
import com.fathy.alfred.backend.board.domain.model.RetestCheck;
import com.fathy.alfred.backend.board.domain.model.StepState;
import com.fathy.alfred.backend.board.domain.model.TestStep;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import com.fathy.alfred.backend.links.application.port.out.EnvBoardPort;
import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CreateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.StartRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Environments' board side (D35-D41): what a board asks (its requirement items, test steps, Fixed cards) - from this
 * Alfred's board, or from the host's read through the stream; the host's own column; starting a test cycle; and judging
 * a re-test. A re-test of an environment is judged by the host's own re-test code on the environment's cycle, which the
 * host reads over the link (the cycle is streamed to it automatically), so a fix is judged the same on every
 * environment - and only that cycle's calls count (D41).
 */
@Component
public class LinksEnvBoard implements EnvBoardPort {

    static final Duration WAIT = Duration.ofSeconds(60);

    private final ObjectProvider<RequirementUseCase> requirements;
    private final ObjectProvider<TestStepsUseCase> steps;
    private final ObjectProvider<QueryCardsUseCase> cards;
    private final ObjectProvider<RetestUseCase> retests;
    private final ObjectProvider<ManageBoardsUseCase> boards;
    private final ObjectProvider<RelateCycleUseCase> relations;
    private final ObjectProvider<CreateSessionCycleUseCase> createCycle;
    private final ObjectProvider<StartRecordingUseCase> startRecording;
    private final ObjectProvider<RelayUseCase> relay;
    private final StreamScope scope;
    private final ObjectMapper json = new ObjectMapper();

    public LinksEnvBoard(ObjectProvider<RequirementUseCase> requirements, ObjectProvider<TestStepsUseCase> steps, ObjectProvider<QueryCardsUseCase> cards,
                         ObjectProvider<RetestUseCase> retests, ObjectProvider<ManageBoardsUseCase> boards, ObjectProvider<RelateCycleUseCase> relations,
                         ObjectProvider<CreateSessionCycleUseCase> createCycle, ObjectProvider<StartRecordingUseCase> startRecording,
                         ObjectProvider<RelayUseCase> relay, StreamScope scope) {
        this.requirements = requirements;
        this.steps = steps;
        this.cards = cards;
        this.retests = retests;
        this.boards = boards;
        this.relations = relations;
        this.createCycle = createCycle;
        this.startRecording = startRecording;
        this.relay = relay;
        this.scope = scope;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private JsonNode fetch(String slug, String path, String query) {
        RelayUseCase r = relay.getObject();
        try {
            BlockingResponse.Whole w = r.fetch(slug, RelayRequest.get(path, query), WAIT, 32 * 1024 * 1024);
            if (w.status() >= 400) {
                JsonNode err = json.readTree(w.body().length == 0 ? "{}".getBytes() : w.body());
                throw new IllegalStateException(err.path("message").asText("The host refused (" + w.status() + ")"));
            }
            return json.readTree(w.body());
        } catch (IOException e) {
            throw new IllegalStateException("The host's answer could not be read");
        } catch (LinkUnavailableException e) {
            throw new IllegalStateException(e.getMessage());
        }
    }

    @Override
    public Asks asks(String viaSlug, String boardId) {
        if (viaSlug == null) {
            List<Item> items = new ArrayList<>();
            RequirementUseCase r = requirements.getIfAvailable();
            if (r != null) {
                r.requirements(boardId).items().forEach(i -> items.add(new Item(i.fileName(), i.itemKey(), i.text())));
            }
            List<String> stepKeys = new ArrayList<>();
            TestStepsUseCase s = steps.getIfAvailable();
            if (s != null) {
                s.steps(boardId).forEach(t -> stepKeys.add(t.key()));
            }
            return new Asks(items, stepKeys, fixedCards(boardId));
        }
        JsonNode req = fetch(viaSlug, "/board/cycles/" + enc(boardId) + "/requirements", "");
        List<Item> items = new ArrayList<>();
        req.path("items").forEach(i -> items.add(new Item(i.path("fileName").asText(), i.path("itemKey").asText(), i.path("text").asText(""))));
        JsonNode st = fetch(viaSlug, "/board/cycles/" + enc(boardId) + "/steps", "");
        List<String> stepKeys = new ArrayList<>();
        (st.isArray() ? st : st.path("steps")).forEach(t -> stepKeys.add(t.path("key").asText()));
        String project = scope.projectOf(boardId).orElse(null);
        JsonNode page = fetch(viaSlug, "/board/cards", "cycleId=" + enc(boardId) + (project == null ? "" : "&project=" + enc(project))
                + "&status=FIXED&limit=500");
        List<Integer> fixed = new ArrayList<>();
        page.path("cards").forEach(c -> {
            if ("FIXED".equals(c.path("status").asText())) {
                fixed.add(c.path("number").asInt());
            }
        });
        return new Asks(items, stepKeys, fixed);
    }

    private List<Integer> fixedCards(String boardId) {
        QueryCardsUseCase q = cards.getIfAvailable();
        String project = scope.projectOf(boardId).orElse(null);
        if (q == null || project == null) {
            return List.of();
        }
        CardQuery query = new CardQuery(project, null, Set.of(), Set.of(CardStatus.FIXED), Set.of(), null, false, null, 0, CardQuery.MAX_LIMIT)
                .onBoard(boardId, false);
        return q.query(query).cards().stream().map(CardSummary::card).filter(c -> c.status() == CardStatus.FIXED).map(c -> c.number())
                .collect(Collectors.toList());
    }

    @Override
    public List<EnvMark> hostMarks(String boardId) {
        RequirementUseCase r = requirements.getIfAvailable();
        if (r == null) {
            return List.of();
        }
        List<EnvMark> out = new ArrayList<>();
        for (RequirementUseCase.Requirement i : r.requirements(boardId).items()) {
            if (i.mark() != null && !i.mark().isBlank()) {
                out.add(new EnvMark(null, boardId, i.fileName(), i.itemKey(), i.mark(), "", "user", null, "[]"));
            }
        }
        return out;
    }

    @Override
    public List<EnvStep> hostSteps(String boardId) {
        TestStepsUseCase s = steps.getIfAvailable();
        if (s == null) {
            return List.of();
        }
        List<EnvStep> out = new ArrayList<>();
        for (TestStep t : s.steps(boardId)) {
            if (t.state() == StepState.SEEN || t.state() == StepState.FAILED) {
                out.add(new EnvStep(null, boardId, t.key(), t.state().name(), t.note(), "user", t.at()));
            }
        }
        return out;
    }

    @Override
    public List<EnvRetest> hostRetests(String boardId) {
        RetestUseCase r = retests.getIfAvailable();
        String project = scope.projectOf(boardId).orElse(null);
        List<Integer> fixed = fixedCards(boardId);
        if (r == null || project == null || fixed.isEmpty()) {
            return List.of();
        }
        List<EnvRetest> out = new ArrayList<>();
        for (RetestCheck c : r.check(project, fixed, null)) {
            out.add(new EnvRetest(null, boardId, c.number(), outcome(c.verdict()), c.summary(), null, "re-test", c.since()));
        }
        return out;
    }

    static String outcome(RetestCheck.Verdict v) {
        if (v == null) {
            return "UNKNOWN";
        }
        return switch (v) {
            case PASSES -> "PASS";
            case FAILS, PARTIAL, FLAKY -> "FAIL";
            default -> "UNKNOWN";
        };
    }

    @Override
    public String startCycle(String project, String name) {
        // a test run for an environment records alone: this Alfred's other recordings of the project are paused first
        // (they may be on no board here, where the recording guard cannot see their project)
        pauseRecordingsOf(project);
        SessionCycle c = createCycle.getObject().create(new NewSessionCycle(name, project));
        startRecording.getObject().startRecording(c.id(), true);
        return c.id();
    }

    private ObjectProvider<com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase> listCycles;
    private ObjectProvider<com.fathy.alfred.backend.sessioncycles.application.port.in.PauseRecordingUseCase> pauseRecording;

    @org.springframework.beans.factory.annotation.Autowired
    void setRecordingControls(ObjectProvider<com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase> listCycles,
                              ObjectProvider<com.fathy.alfred.backend.sessioncycles.application.port.in.PauseRecordingUseCase> pauseRecording) {
        this.listCycles = listCycles;
        this.pauseRecording = pauseRecording;
    }

    private void pauseRecordingsOf(String project) {
        var list = listCycles == null ? null : listCycles.getIfAvailable();
        var pause = pauseRecording == null ? null : pauseRecording.getIfAvailable();
        if (list == null || pause == null || project == null) {
            return;
        }
        for (SessionCycle c : list.listAll()) {
            if (c.status() == com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus.RECORDING && project.equals(c.assignedTo())) {
                pause.pauseRecording(c.id());
            }
        }
    }

    @Override
    public void linkCycle(String boardId, String cycleRef) {
        RelateCycleUseCase r = relations.getIfAvailable();
        if (r != null) {
            r.relateCycle(Actor.USER, boardId, cycleRef);
        }
    }

    @Override
    public List<Verdict> judge(String viaSlug, String boardId, List<Integer> cardNumbers, String cycleId) {
        if (viaSlug != null) {
            JsonNode n = fetch(viaSlug, "/links/data/env-judge", "boardId=" + enc(boardId) + "&cycleId=" + enc(cycleId) + "&cards="
                    + cardNumbers.stream().map(String::valueOf).collect(Collectors.joining(",")));
            List<Verdict> out = new ArrayList<>();
            n.forEach(v -> out.add(new Verdict(v.path("cardNumber").asInt(), v.path("verdict").asText("UNKNOWN"), v.path("summary").asText(""))));
            return out;
        }
        return judgeHere(boardId, cardNumbers, cycleId);
    }

    /** This Alfred's own re-test code on one cycle's calls (a local cycle, or an environment Alfred's {@code id@slug}). */
    List<Verdict> judgeHere(String boardId, List<Integer> cardNumbers, String cycleRef) {
        RetestUseCase r = retests.getIfAvailable();
        String project = scope.projectOf(boardId).orElse(null);
        if (r == null || project == null) {
            return List.of();
        }
        List<Integer> fixed = fixedCards(boardId);
        List<Integer> numbers = cardNumbers == null || cardNumbers.isEmpty() ? fixed : cardNumbers.stream().filter(fixed::contains).toList();
        if (numbers.isEmpty()) {
            return List.of();
        }
        List<Verdict> out = new ArrayList<>();
        for (RetestCheck c : r.check(project, numbers, cycleRef)) {
            out.add(new Verdict(c.number(), outcome(c.verdict()), c.summary()));
        }
        return out;
    }
}
