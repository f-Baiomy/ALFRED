package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fathy.alfred.backend.board.adapter.out.sqlite.TestRepositories;
import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase.Requirement;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.CallFactsPort;
import com.fathy.alfred.backend.board.domain.AcceptanceItems;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardRef;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck.Kind;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.Verdict;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/018: the 61813 cycle replayed - every Acceptance item judged from the calls, a missing feature carded at once. */
class RequirementServiceTest {

    private static final String CYCLE = "decc8783";
    private static final String PROJECT = "odeysys";
    private static final String PATH = "/odeysysadmin/Booking2/refunded-requests/search";
    private static final String ENDPOINT = "POST " + PATH;
    private static final String SPEC = """
            # Refunded Requests filters
            ## Acceptance
            - The Agency dropdown on Refunded Requests lists an "All Agencies" option.
            - Searching with All Agencies returns requests of every agency the Admin may access.
            - The Branch dropdown keeps several branches selected at once.
            - Searching with several branches returns requests of any selected branch (OR).
            - Searching with All Branches applies no branch restriction.
            - Searching with one branch returns only that branch's requests.
            - Changing from All Branches to specific branches filters by those branches.
            """;
    private static final String OLD_REQUEST = "{\"branchId\":948,\"agencyIds\":[949,10646],\"pnr\":null,\"fromDate\":\"2026-10-07\","
            + "\"toDate\":\"2026-10-14\",\"status\":null,\"requestType\":0,\"page\":1,\"size\":10}";
    private static final String EMPTY = "{\"payload\":[],\"total\":0}";

    private static final EvidenceCheck LIST = new EvidenceCheck(Kind.REQUEST_SHAPE, "$.branch*", "list", null, null, null, null);
    private static final EvidenceCheck ROWS = new EvidenceCheck(Kind.ROWS_PRESENT, null, null, "$.payload", null, null, null);
    private static final EvidenceCheck ROWS_MATCH = new EvidenceCheck(Kind.ROWS_MATCH_FILTER, "$.branch*", null, "$.payload", "branch*", null, null);

    @TempDir
    Path dir;
    private BoardFixture f;
    private RequirementService service;
    private final Map<String, CallFactsPort.CallBodies> bodies = new HashMap<>();
    private int calls;
    private CallFactsPort facts;
    private BoardNotificationPort quiet;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        facts = new CallFactsPort() {
            @Override
            public Optional<com.fathy.alfred.backend.board.domain.model.CallFacts> facts(String callId, String cycleId, Set<String> paths) {
                return Optional.empty();
            }

            @Override
            public Optional<CycleCall> call(String ref) {
                return Optional.empty();
            }

            @Override
            public Optional<CallBodies> bodies(String callId, String cycleId) {
                return Optional.ofNullable(bodies.get(callId));
            }
        };
        quiet = new BoardNotificationPort() {
            @Override
            public void changed(String project, String cycleId, String cardId, String what) {
                f.signals.add(what + ":" + project + ":" + cycleId);
            }

            @Override
            public void agentStatus(com.fathy.alfred.backend.board.domain.model.AgentStatus status) {
            }
        };
        service = new RequirementService(TestRepositories.requirements(f.store, JsonMapper.builder().findAndAddModules().build()), f.store,
                (cycleId, limit) -> List.copyOf(f.cycleCalls), facts, f.board, f.board, f.board, f.board, f.board, quiet, f.clock);
        service.stop(); // no background judging: every judging run here is on the test's thread, in order
        f.briefs.put(Actor.USER, CYCLE, "spec.md", SPEC);
    }

    @AfterEach
    void tearDown() throws Exception {
        service.stop();
        f.close();
    }

    private String key(int n) {
        return AcceptanceItems.of(SPEC).get(n - 1).key();
    }

    private void evidence(Actor actor, int item, String endpoint, EvidenceCheck... checks) {
        RequirementUseCase.EvidenceChange change = service.putEvidence(actor,
                new ItemEvidence(CYCLE, "spec.md", key(item), PROJECT, endpoint, List.of(checks), "", null, null));
        assertThat(change.outcome()).as(change.message()).isEqualTo(CardChange.Outcome.OK);
    }

    /** The evidence Claude would draft for the 61813 spec. */
    private void draftAll() {
        evidence(Actor.CLAUDE, 1, "UI");
        evidence(Actor.CLAUDE, 2, ENDPOINT, new EvidenceCheck(Kind.REQUEST_WHEN, "$.agency*", "none", null, null, null, null), ROWS);
        evidence(Actor.CLAUDE, 3, ENDPOINT, LIST);
        evidence(Actor.CLAUDE, 4, ENDPOINT, LIST, new EvidenceCheck(Kind.REQUEST_WHEN, "$.branch*", "list>=2", null, null, null, null), ROWS_MATCH, ROWS);
        evidence(Actor.CLAUDE, 5, ENDPOINT, LIST, new EvidenceCheck(Kind.REQUEST_WHEN, "$.branch*", "none", null, null, null, null), ROWS);
        evidence(Actor.CLAUDE, 6, ENDPOINT, new EvidenceCheck(Kind.REQUEST_WHEN, "$.branch*", "one", null, null, null, null), ROWS_MATCH, ROWS);
        evidence(Actor.CLAUDE, 7, ENDPOINT, LIST, new EvidenceCheck(Kind.REQUEST_WHEN, "$.branch*", "list", null, null, null, null));
    }

    private String search(String request, String response) {
        String id = "call-" + (++calls);
        f.cycleCalls.add(new CycleCall("in", id, "POST", PATH, 200, "ok|" + ENDPOINT, f.clock.instant(), 50.0));
        bodies.put(id, new CallFactsPort.CallBodies(200, request, response));
        f.clock.advanceSeconds(5);
        return id;
    }

    private Map<Integer, Verdict> verdicts() {
        List<Requirement> items = service.requirements(CYCLE).items();
        Map<Integer, Verdict> out = new HashMap<>();
        for (int i = 0; i < items.size(); i++) {
            out.put(i + 1, items.get(i).verdict().verdict());
        }
        return out;
    }

    private List<String> callsOf(Card card) {
        return f.store.linksOf(card.id()).stream().map(MentionRef::callId).filter(java.util.Objects::nonNull).toList();
    }

    private Set<Integer> cardsOf(int... items) {
        Map<String, List<CardRef>> cards = f.store.cardsBySpecItem(CYCLE);
        return java.util.Arrays.stream(items).boxed()
                .flatMap(i -> cards.getOrDefault("spec.md\n" + key(i), List.of()).stream().map(CardRef::number))
                .collect(Collectors.toSet());
    }

    @Test
    void theOldSearchCardsTheMissingBranchListOnTheFirstCallAsOneTask() {
        draftAll();
        String first = search(OLD_REQUEST, EMPTY);
        for (int i = 0; i < 4; i++) {
            search(OLD_REQUEST, EMPTY);
        }

        Map<Integer, Verdict> v = verdicts();
        assertThat(v).containsEntry(1, Verdict.MANUAL).containsEntry(2, Verdict.NOT_EXERCISED)
                .containsEntry(3, Verdict.MISSING).containsEntry(4, Verdict.MISSING).containsEntry(5, Verdict.MISSING)
                .containsEntry(6, Verdict.NO_DATA).containsEntry(7, Verdict.MISSING);

        Set<Integer> numbers = cardsOf(3, 4, 5, 7);
        assertThat(numbers).hasSize(1);
        assertThat(cardsOf(1, 2, 6)).isEmpty();
        Card card = f.store.findByNumber(PROJECT, numbers.iterator().next()).orElseThrow();
        assertThat(card.kind()).isEqualTo(CardKind.TASK);
        assertThat(card.status()).isEqualTo(CardStatus.INBOX);
        assertThat(card.author()).isEqualTo(Actor.CLAUDE);
        assertThat(card.cycleId()).isEqualTo(CYCLE);
        assertThat(card.title()).startsWith("Missing feature: ").endsWith("(and 3 more)");
        assertThat(card.description()).contains("request $.branch* is a list - sent branchId: 948").contains("@[spec:" + CYCLE + "/spec.md|");
        assertThat(callsOf(card)).hasSize(5).contains(first);
        assertThat(f.store.commentCounts(List.of(card.id()))).containsEntry(card.id(), 1);

        // judging again opens nothing new and links nothing twice
        search(OLD_REQUEST, EMPTY);
        verdicts();
        verdicts();
        assertThat(cardsOf(3, 4, 5, 7)).isEqualTo(numbers);
        assertThat(callsOf(card)).hasSize(6);
    }

    @Test
    void aNewBuildStartsTheItemsFreshAndTheCardIsToldWhenItsItemsAreMet() {
        draftAll();
        search(OLD_REQUEST, EMPTY);
        verdicts();
        Card card = f.store.findByNumber(PROJECT, cardsOf(3).iterator().next()).orElseThrow();

        f.store.putAppStart(PROJECT, f.clock.instant());
        f.clock.advanceSeconds(30);
        search("{\"branchIds\":[1,2],\"agencyIds\":[949]}", "{\"payload\":[{\"branchId\":1},{\"branchId\":2}],\"total\":2}");
        Map<Integer, Verdict> v = verdicts();

        assertThat(v).containsEntry(3, Verdict.MET).containsEntry(4, Verdict.MET).containsEntry(7, Verdict.MET)
                .containsEntry(5, Verdict.NOT_EXERCISED);
        assertThat(f.store.commentCounts(List.of(card.id())).get(card.id())).isGreaterThan(1);
        assertThat(f.store.find(card.id()).orElseThrow().status()).isEqualTo(CardStatus.INBOX); // never moved or closed in code
    }

    @Test
    void anAnswerThatLeaksAnotherBranchIsAWrongResultBug() {
        evidence(Actor.CLAUDE, 4, ENDPOINT, LIST, new EvidenceCheck(Kind.REQUEST_WHEN, "$.branch*", "list>=2", null, null, null, null), ROWS_MATCH, ROWS);
        search("{\"branchIds\":[1,2]}", "{\"payload\":[{\"branchId\":1},{\"branchId\":9}]}");

        assertThat(verdicts()).containsEntry(4, Verdict.WRONG);
        Card card = f.store.findByNumber(PROJECT, cardsOf(4).iterator().next()).orElseThrow();
        assertThat(card.kind()).isEqualTo(CardKind.BUG);
        assertThat(card.title()).startsWith("Wrong result: ");
    }

    @Test
    void anItemTheUserDismissedIsNeverCardedAgain() {
        draftAll();
        search(OLD_REQUEST, EMPTY);
        verdicts();
        Card card = f.store.findByNumber(PROJECT, cardsOf(3).iterator().next()).orElseThrow();
        assertThat(f.board.close(Actor.USER, card.id(), Resolution.FINE, "the old page stays for now").outcome()).isEqualTo(CardChange.Outcome.OK);

        evidence(Actor.CLAUDE, 3, ENDPOINT, LIST); // re-drafted: every call is judged again
        search(OLD_REQUEST, EMPTY);
        verdicts();
        assertThat(cardsOf(3)).containsExactly(card.number());
    }

    @Test
    void claudeNeverOverwritesEvidenceTheUserWrote() {
        evidence(Actor.USER, 3, ENDPOINT, LIST);
        RequirementUseCase.EvidenceChange change = service.putEvidence(Actor.CLAUDE,
                new ItemEvidence(CYCLE, "spec.md", key(3), PROJECT, ENDPOINT, List.of(ROWS), "", null, null));
        assertThat(change.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(service.deleteEvidence(Actor.CLAUDE, CYCLE, "spec.md", key(3)).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(service.putEvidence(Actor.CLAUDE, new ItemEvidence(CYCLE, "spec.md", "nope", PROJECT, ENDPOINT, List.of(LIST), "", null, null))
                .outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
    }

    @Test
    void aCallStillWithoutBodiesIsJudgedWhenTheyArriveAndOnlyCallsToTheEndpointCount() {
        evidence(Actor.CLAUDE, 3, ENDPOINT, LIST);
        String id = "late";
        f.cycleCalls.add(new CycleCall("in", id, "POST", PATH, 200, "ok|" + ENDPOINT, f.clock.instant(), 50.0));
        f.cycleCalls.add(new CycleCall("in", "other", "GET", "/odeysysadmin/Booking2/refunded-requests", 200,
                "ok|GET /odeysysadmin/Booking2/refunded-requests", f.clock.instant(), 50.0));
        assertThat(verdicts()).containsEntry(3, Verdict.NOT_EXERCISED);

        bodies.put(id, new CallFactsPort.CallBodies(200, OLD_REQUEST, EMPTY));
        assertThat(verdicts()).containsEntry(3, Verdict.MISSING);
    }

    @Test
    void theCheckStopsOpeningCardsAfterTenAnHour() {
        StringBuilder spec = new StringBuilder("## Acceptance\n");
        for (int i = 1; i <= 12; i++) {
            spec.append("- Item ").append(i).append(" needs field").append(i).append(" sent.\n");
        }
        f.briefs.put(Actor.USER, CYCLE, "many.md", spec.toString());
        List<AcceptanceItems.Item> items = AcceptanceItems.of(spec.toString());
        for (int i = 0; i < 12; i++) {
            service.putEvidence(Actor.CLAUDE, new ItemEvidence(CYCLE, "many.md", items.get(i).key(), PROJECT, ENDPOINT,
                    List.of(new EvidenceCheck(Kind.REQUEST_SHAPE, "$.field" + (i + 1), "present", null, null, null, null)), "", null, null));
        }
        search(OLD_REQUEST, EMPTY);
        service.requirements(CYCLE);

        long missing = java.util.stream.IntStream.rangeClosed(1, 20).mapToObj(n -> f.store.findByNumber(PROJECT, n)).flatMap(Optional::stream)
                .filter(c -> c.title().startsWith("Missing feature")).count();
        long paused = java.util.stream.IntStream.rangeClosed(1, 20).mapToObj(n -> f.store.findByNumber(PROJECT, n)).flatMap(Optional::stream)
                .filter(c -> c.title().startsWith("Requirement check paused")).count();
        assertThat(missing).isEqualTo(RequirementService.CARDS_PER_HOUR);
        assertThat(paused).isEqualTo(1);
    }

    @Test
    void aBurstOfCallsCostsOneJudgingPassPerCycle() throws Exception {
        java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
        RequirementService live = new RequirementService(TestRepositories.requirements(f.store, JsonMapper.builder().findAndAddModules().build()),
                f.store, (cycleId, limit) -> {
                    reads.incrementAndGet();
                    return List.copyOf(f.cycleCalls);
                }, facts, f.board, f.board, f.board, f.board, f.board, quiet, f.clock);
        try {
            live.putEvidence(Actor.CLAUDE, new ItemEvidence(CYCLE, "spec.md", key(3), PROJECT, ENDPOINT, List.of(LIST), "", null, null));
            long until = System.currentTimeMillis() + 5000;
            while (reads.get() == 0 && System.currentTimeMillis() < until) {
                Thread.sleep(20); // the pass the evidence save starts
            }
            int before = reads.get();
            for (int i = 0; i < 100; i++) {
                search(OLD_REQUEST, EMPTY);
                live.callArrived(PROJECT, ENDPOINT);
            }
            Thread.sleep(RequirementService.COALESCE_MS + 1000L);
            assertThat(reads.get() - before).as("100 calls in a burst").isEqualTo(1);
            assertThat(live.requirements(CYCLE).items().get(2).verdict().verdict()).isEqualTo(Verdict.MISSING);
        } finally {
            live.stop();
        }
    }

    @Test
    void anItemsShortNameIsWhatItsMentionsReadAndClaudeMayOnlyGiveTheFirstOne() {
        RequirementUseCase.NameChange first = service.setShortName(Actor.CLAUDE, CYCLE, "spec.md", key(6), "one-branch search");
        assertThat(first.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(service.requirements(CYCLE).items().get(5).shortName()).isEqualTo("one-branch search");
        assertThat(service.requirements(CYCLE).items().get(0).shortName()).isNull();

        assertThat(service.setShortName(Actor.CLAUDE, CYCLE, "spec.md", key(6), "single branch").outcome())
                .isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(service.setShortName(Actor.USER, CYCLE, "spec.md", key(6), "single branch").outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(service.requirements(CYCLE).items().get(5).shortName()).isEqualTo("single branch");

        assertThat(service.setShortName(Actor.USER, CYCLE, "spec.md", key(6), "a|b").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(service.setShortName(Actor.USER, CYCLE, "spec.md", "nope", "x").outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
        assertThat(service.setShortName(Actor.USER, CYCLE, "spec.md", key(6), " ").outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(service.requirements(CYCLE).items().get(5).shortName()).isNull();
    }

    @Test
    void aCardsShortNameShowsOnTheBoardAndInTheDrawer() {
        String id = f.add(Actor.CLAUDE, PROJECT, CardKind.TASK, "Not exercised: Searching with All Agencies returns requests (AC2)", "").card().id();
        assertThat(f.board.setShortName(Actor.CLAUDE, id, "All Agencies  untested").outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.board.get(id).orElseThrow().shortName()).isEqualTo("All Agencies untested");
        assertThat(f.board.query(new com.fathy.alfred.backend.board.domain.model.CardQuery(PROJECT, null, null, null, null, null, false, null, 0, 50))
                .cards().get(0).shortName()).isEqualTo("All Agencies untested");
        assertThat(f.board.setShortName(Actor.CLAUDE, id, "other").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.setShortName(Actor.USER, id, "x".repeat(61)).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.setShortName(Actor.USER, id, "agencies").card().shortName()).isEqualTo("agencies");
    }

    // ------------------------------------------------------------------------------------- boards (specs/027 FR-001a, FR-005)

    private com.fathy.alfred.backend.board.domain.model.Board taskBoard(String id, com.fathy.alfred.backend.board.domain.model.BoardState state) {
        var b = new com.fathy.alfred.backend.board.domain.model.Board(id, PROJECT, "Refunded filters", false, state, null,
                f.clock.instant(), f.clock.instant(), Actor.USER);
        f.boardModel.putBoard(b);
        return b;
    }

    /** A service whose task has no captured calls: everything it judges comes from the project's live calls. */
    private RequirementService liveOnly() {
        RequirementService s = new RequirementService(TestRepositories.requirements(f.store, JsonMapper.builder().findAndAddModules().build()), f.store,
                (cycleId, limit) -> List.of(), facts, f.board, f.board, f.board, f.board, f.board, quiet, f.clock);
        s.stop();
        s.setBoards(f.boardModel, new com.fathy.alfred.backend.board.application.port.out.LiveCallsPort() {
            @Override
            public List<CycleCall> recent(int limit) {
                return List.copyOf(f.cycleCalls);
            }
        });
        return s;
    }

    @Test
    void anArchivedBoardJudgesNoNewCalls() {
        taskBoard(CYCLE, com.fathy.alfred.backend.board.domain.model.BoardState.ARCHIVED);
        service.setBoards(f.boardModel, null);
        draftAll();
        search(OLD_REQUEST, EMPTY);

        assertThat(verdicts()).containsEntry(3, Verdict.NOT_EXERCISED);
        assertThat(cardsOf(3, 4, 5, 7)).isEmpty();
    }

    @Test
    void anOpenBoardJudgesItsProjectsLiveCallsAndMentionsThemLive() {
        taskBoard(CYCLE, com.fathy.alfred.backend.board.domain.model.BoardState.OPEN);
        service = liveOnly();
        draftAll();
        String id = search(OLD_REQUEST, EMPTY);

        assertThat(verdicts()).containsEntry(3, Verdict.MISSING);
        Set<Integer> numbers = cardsOf(3, 4, 5, 7);
        assertThat(numbers).hasSize(1);
        Card card = f.store.findByNumber(PROJECT, numbers.iterator().next()).orElseThrow();
        assertThat(f.store.linksOf(card.id())).extracting(MentionRef::ref).contains("in:" + id);
    }

    @Test
    void eachBoardKeepsItsOwnVerdicts() {
        String other = "b-other";
        taskBoard(CYCLE, com.fathy.alfred.backend.board.domain.model.BoardState.OPEN);
        taskBoard(other, com.fathy.alfred.backend.board.domain.model.BoardState.OPEN);
        f.briefs.put(Actor.USER, other, "spec.md", SPEC);
        service = liveOnly();
        draftAll(); // evidence on CYCLE only
        search(OLD_REQUEST, EMPTY);

        assertThat(verdicts()).containsEntry(3, Verdict.MISSING);
        assertThat(service.requirements(other).items()).allSatisfy(r -> assertThat(r.verdict().verdict()).isNotEqualTo(Verdict.MISSING));
    }
}
