package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.adapter.out.sqlite.TestRepositories;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.NewBoard;
import com.fathy.alfred.backend.board.application.port.out.RequirementStorePort;
import com.fathy.alfred.backend.board.application.port.in.CycleVerdictsUseCase;
import com.fathy.alfred.backend.board.application.port.in.FindingHomeUseCase.Home;
import com.fathy.alfred.backend.board.application.port.in.FindingHomeUseCase.Kind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** One cycle on several boards (specs/027 US3, research R5): where a finding goes, and each board's verdicts side by side. */
class ListenHomeResolverTest {

    private static final String CYCLE = "c-shared";
    private static final String ENDPOINT = "POST /api/refund";

    @TempDir
    Path dir;
    BoardFixture f;
    RequirementStorePort requirements;
    ListenHomeResolver resolver;
    String refund;
    String sprint;

    @BeforeEach
    void open() {
        f = new BoardFixture(dir);
        requirements = TestRepositories.requirements(f.store, JsonMapper.builder().findAndAddModules().build());
        resolver = new ListenHomeResolver(f.boardModel, f.store, requirements);
        refund = f.boards.create(Actor.USER, new NewBoard("odeysys", "Refund", List.of(CYCLE), null, false, null)).board().id();
        sprint = f.boards.create(Actor.USER, new NewBoard("odeysys", "Sprint", List.of(CYCLE), null, false, null)).board().id();
    }

    @AfterEach
    void close() throws Exception {
        f.close();
    }

    private void names(String board, String endpoint) {
        requirements.putEvidence(new ItemEvidence(board, "spec.md", "k1", "odeysys", endpoint,
                List.of(new EvidenceCheck(EvidenceCheck.Kind.STATUS, null, null, null, null, null, "200-299")), "", Actor.USER, f.clock.instant()));
    }

    @Test
    void withNoBoardNamingItTheStartingBoardIsHome() {
        assertThat(resolver.resolve("odeysys", CYCLE, ENDPOINT, null, sprint)).extracting(Home::kind, Home::boardId).containsExactly(Kind.HOME, sprint);
        // from Session Cycles there is no starting board: two open boards, neither default -> the project's default board
        assertThat(resolver.resolve("odeysys", CYCLE, ENDPOINT, null, null).boardId()).isEqualTo(BoardIds.defaultOf("odeysys"));
    }

    @Test
    void theOneBoardWhoseItemsNameTheEndpointIsHome() {
        names(refund, ENDPOINT);
        assertThat(resolver.resolve("odeysys", CYCLE, ENDPOINT, null, sprint)).extracting(Home::kind, Home::boardId).containsExactly(Kind.HOME, refund);
    }

    @Test
    void severalBoardsNamingItAsk() {
        names(refund, ENDPOINT);
        names(sprint, ENDPOINT);
        Home h = resolver.resolve("odeysys", CYCLE, ENDPOINT, null, sprint);
        assertThat(h.kind()).isEqualTo(Kind.ASK);
        assertThat(h.options()).extracting(b -> b.id()).containsExactlyInAnyOrder(refund, sprint);
    }

    @Test
    void anArchivedBoardTakesNothing() {
        names(refund, ENDPOINT);
        names(sprint, ENDPOINT);
        f.boards.update(Actor.USER, sprint, null, BoardState.ARCHIVED);
        assertThat(resolver.resolve("odeysys", CYCLE, ENDPOINT, null, sprint)).extracting(Home::kind, Home::boardId).containsExactly(Kind.HOME, refund);
    }

    @Test
    void theSameFindingOnARelatedBoardBecomesEvidence() {
        var c = f.board.create(Actor.CLAUDE, new CreateCardUseCase.NewCard("odeysys", CardKind.BUG, "500 on refund", "", Set.of(), refund, null, List.of()))
                .card().card();
        f.store.update(c.withSignature("err|" + ENDPOINT));
        Home h = resolver.resolve("odeysys", CYCLE, ENDPOINT, "err|" + ENDPOINT, sprint);
        assertThat(h.kind()).isEqualTo(Kind.EVIDENCE);
        assertThat(h.card()).isEqualTo(c.number());
    }

    @Test
    void verdictsShowEachBoardsItemsPerCall() {
        names(refund, ENDPOINT);
        f.cycleCalls.add(new CycleCall("in", "call-1", "POST", "/api/refund", 500, "err|" + ENDPOINT, f.clock.instant(), 12.0));
        f.cycleCalls.add(new CycleCall("in", "call-2", "GET", "/api/other", 200, "ok|GET /api/other", f.clock.instant(), 3.0));
        requirements.putResults(refund, "spec.md", "k1", List.of(new RequirementStorePort.CallRow("call-1", CallResult.WRONG, "500", f.clock.instant())));
        CycleVerdictsService verdicts = new CycleVerdictsService(f.boardModel, requirements, f.store, (id, limit) -> List.copyOf(f.cycleCalls));

        CycleVerdictsUseCase.CycleVerdicts all = verdicts.verdicts(CYCLE, null, 100);
        assertThat(all.boards()).extracting(CycleVerdictsUseCase.BoardMarks::boardId).containsExactlyInAnyOrder(refund, sprint);
        assertThat(all.calls()).hasSize(2);
        assertThat(all.calls().get(0).boards()).singleElement().satisfies(b -> {
            assertThat(b.boardId()).isEqualTo(refund);
            assertThat(b.items()).extracting(CycleVerdictsUseCase.ItemMark::result).containsExactly(CallResult.WRONG);
        });
        assertThat(verdicts.verdicts(CYCLE, refund, 100).calls()).extracting(CycleVerdictsUseCase.CallVerdicts::callId).containsExactly("call-1");
        assertThat(verdicts.verdicts(CYCLE, sprint, 100).calls()).isEmpty();
    }
}
