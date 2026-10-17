package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Post;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.NewBoard;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardActivity;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.board.domain.model.BoardOutcome;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardSummary;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Boards as tasks (specs/027 US1, US2, FR-001..004, FR-010..012, FR-040). */
class BoardsServiceTest {

    @TempDir
    Path dir;
    BoardFixture f;

    @BeforeEach
    void open() {
        f = new BoardFixture(dir);
    }

    @AfterEach
    void close() throws Exception {
        f.close();
    }

    private Result create(Actor actor, String name, String askedIn) {
        return f.boards.create(actor, new NewBoard("odeysys", name, List.of(), null, false, askedIn));
    }

    private CardDetail card(String cycleId, String title) {
        return f.board.create(Actor.USER, new CreateCardUseCase.NewCard("odeysys", CardKind.BUG, title, "", Set.of(), cycleId, null, List.of()))
                .card();
    }

    private List<String> titlesOn(String board, boolean related) {
        return f.board.query(new CardQuery("odeysys", null, Set.of(), Set.of(), Set.of(), null, false, null, 0, 200).onBoard(board, related))
                .cards().stream().map(CardSummary::card).map(c -> c.title()).toList();
    }

    @Test
    void createsABoardWithAFirstRecordingAndRelatesCycles() {
        f.cyclesHere.add("c-old");
        Result r = f.boards.create(Actor.USER, new NewBoard("odeysys", "Login lockout", List.of("c-old"), null, true, null));

        assertThat(r.outcome()).isEqualTo(BoardOutcome.OK);
        String id = r.board().id();
        assertThat(f.boards.cyclesOf(id)).hasSize(2).contains("c-old");
        assertThat(f.boards.cyclesOf(id).get(1)).startsWith("cyc-new-");
        assertThat(f.boards.get(BoardIds.defaultOf("odeysys"))).isPresent();
        assertThat(f.boards.list("odeysys", Set.of(), null, 50)).extracting(s -> s.board().name()).containsExactly("odeysys", "Login lockout");
    }

    /** specs/029: a board made from a work item gets a first cycle that does not record until the user says so. */
    @Test
    void anEmptyFirstCycleIsMadeButNotRecording() {
        f.recordingHere.add("c-running");
        f.cyclesHere.add("c-running");
        Result r = f.boards.create(Actor.USER, new NewBoard("odeysys", "#59851_Baggage", List.of(), null, false, null, true));
        String cycle = f.boards.cyclesOf(r.board().id()).get(0);
        assertThat(f.cycleNames.get(cycle)).isEqualTo("#59851_Baggage");
        assertThat(f.recordingHere).containsExactly("c-running"); // its own cycle is paused, the running one untouched
    }

    @Test
    void defaultBoardIsProtected() {
        String def = f.boards.defaultBoard("odeysys").id();
        assertThat(f.boards.update(Actor.USER, def, null, BoardState.ARCHIVED).outcome()).isEqualTo(BoardOutcome.DEFAULT_PROTECTED);
        assertThat(f.boards.delete(Actor.USER, def).outcome()).isEqualTo(BoardOutcome.DEFAULT_PROTECTED);
    }

    @Test
    void deletingABoardMovesItsCardsToTheDefaultAndKeepsItsCycles() {
        f.cyclesHere.add("c1");
        String id = f.boards.create(Actor.USER, new NewBoard("odeysys", "Refund", List.of("c1"), null, false, null)).board().id();
        CardDetail c = card(id, "On the board");
        f.briefs.putBrief(Actor.USER, id, "brief");
        assertThat(f.store.find(c.card().id()).orElseThrow().boardId()).isEqualTo(id);

        assertThat(f.boards.delete(Actor.USER, id).outcome()).isEqualTo(BoardOutcome.OK);

        assertThat(f.store.find(c.card().id()).orElseThrow().boardId()).isEqualTo(BoardIds.defaultOf("odeysys"));
        assertThat(f.boardModel.board(id)).isEmpty();
        assertThat(f.briefs.brief(id).text()).isEmpty();
        assertThat(f.cyclesHere).contains("c1");
    }

    @Test
    void claudeOpensABoardOnlyWhenTheUserAsked() {
        assertThat(create(Actor.CLAUDE, "No ask", null).outcome()).isEqualTo(BoardOutcome.NOT_ASKED);
        assertThat(create(Actor.CLAUDE, "Bogus", "12345").outcome()).isEqualTo(BoardOutcome.NOT_ASKED);

        ChatMessage ask = f.chat.post(Actor.USER, new ChatKey("odeysys", ""),
                new Post("open a board for AB#4533", null, List.of(), null, false, null, List.of())).value();
        assertThat(create(Actor.CLAUDE, "Asked in chat", String.valueOf(ask.id())).outcome()).isEqualTo(BoardOutcome.OK);

        f.clock.advanceSeconds(31 * 60);
        assertThat(create(Actor.CLAUDE, "Too late", String.valueOf(ask.id())).outcome()).isEqualTo(BoardOutcome.NOT_ASKED);

        Result terminal = create(Actor.CLAUDE, "From terminal", "terminal");
        assertThat(terminal.outcome()).isEqualTo(BoardOutcome.OK);
        assertThat(f.boards.activity(terminal.board().id(), 0, 10)).extracting(BoardActivity::text)
                .anyMatch(t -> t.contains("at your request in the terminal"));
    }

    @Test
    void claudeMayNotRenameArchiveOrDelete() {
        String id = create(Actor.USER, "Refund", null).board().id();
        assertThat(f.boards.update(Actor.CLAUDE, id, "x", null).outcome()).isEqualTo(BoardOutcome.REFUSED_FOR_CLAUDE);
        assertThat(f.boards.update(Actor.CLAUDE, id, null, BoardState.ARCHIVED).outcome()).isEqualTo(BoardOutcome.REFUSED_FOR_CLAUDE);
        assertThat(f.boards.delete(Actor.CLAUDE, id).outcome()).isEqualTo(BoardOutcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void claudesRelateCanBeUndone() {
        String id = create(Actor.USER, "Refund", null).board().id();
        f.boards.relateCycle(Actor.CLAUDE, id, "c9");
        assertThat(f.boards.cyclesOf(id)).containsExactly("c9");
        BoardActivity a = f.boards.activity(id, 0, 10).get(0);
        assertThat(a.undo()).isNotNull();

        assertThat(f.boards.undo(Actor.USER, id, a.id()).outcome()).isEqualTo(BoardOutcome.OK);
        assertThat(f.boards.cyclesOf(id)).isEmpty();
        assertThat(f.boards.undo(Actor.USER, id, a.id()).outcome()).isEqualTo(BoardOutcome.REFUSED);
    }

    @Test
    void activityIsCappedPerBoard() {
        String id = create(Actor.USER, "Refund", null).board().id();
        f.boards.activityMaxRows(5);
        for (int i = 0; i < 12; i++) {
            f.boards.relateCycle(Actor.USER, id, "c" + i);
        }
        assertThat(f.boards.activity(id, 0, 100)).hasSize(5);
    }

    @Test
    void aBoardShowsItsOwnAndRelatedCardsAndHomesMove() {
        String refund = create(Actor.USER, "Refund", null).board().id();
        String sprint = create(Actor.USER, "Sprint 42", null).board().id();
        f.boards.relateCycle(Actor.USER, refund, "c-shared");
        f.boards.relateCycle(Actor.USER, sprint, "c-shared");
        CardDetail found = card("c-shared", "Found in shared");
        CardDetail mine = card(refund, "Only refund");

        // a card found in a shared cycle lives on one board (the first open one related to it)
        assertThat(f.store.find(found.card().id()).orElseThrow().boardId()).isEqualTo(refund);
        assertThat(titlesOn(refund, false)).containsExactlyInAnyOrder("Found in shared", "Only refund");
        assertThat(titlesOn(sprint, false)).isEmpty();
        assertThat(titlesOn(sprint, true)).containsExactly("Found in shared");

        // moving its home keeps the number and leaves activity on both boards
        int number = found.card().number();
        assertThat(f.boards.moveHome(Actor.USER, found.card().id(), sprint).card().card().number()).isEqualTo(number);
        assertThat(titlesOn(sprint, false)).containsExactly("Found in shared");
        assertThat(f.boards.activity(sprint, 0, 10)).extracting(BoardActivity::kind).contains(BoardActivity.Kind.MOVE_HOME_IN);
        assertThat(f.boards.activity(refund, 0, 10)).extracting(BoardActivity::kind).contains(BoardActivity.Kind.MOVE_HOME_OUT);

        // a related board shows the other's cards too
        f.boards.relateBoard(Actor.USER, refund, sprint);
        assertThat(titlesOn(refund, true)).containsExactlyInAnyOrder("Found in shared", "Only refund");
        assertThat(mine.card().boardId()).isEqualTo(refund);
    }

    @Test
    void aCardRelatedToAnotherCycleShowsOnItsBoards() {
        String retest = create(Actor.USER, "Re-test board", null).board().id();
        f.boards.relateCycle(Actor.USER, retest, "c-retest");
        CardDetail c = card(null, "Old bug");
        assertThat(titlesOn(retest, true)).isEmpty();

        f.boards.relateCardCycle(Actor.USER, c.card().id(), "c-retest");

        assertThat(titlesOn(retest, true)).containsExactly("Old bug");
        assertThat(f.boards.relatedCycles(c.card().id())).containsExactly("c-retest");
    }

    @Test
    void archivedBoardIsNotListedUnlessAsked() {
        String id = create(Actor.USER, "Old task", null).board().id();
        f.boards.update(Actor.USER, id, null, BoardState.ARCHIVED);
        assertThat(f.boards.list("odeysys", Set.of(BoardState.OPEN, BoardState.DONE), null, 50)).extracting(s -> s.board().id())
                .doesNotContain(id);
        assertThat(f.boards.list("odeysys", Set.of(), null, 50)).extracting(s -> s.board().id()).contains(id);
    }

    @Test
    void claudesMoveHomeCanBeUndoneAndAHomeStaysInItsProject() {
        String refund = create(Actor.USER, "Refund", null).board().id();
        CardDetail c = card(null, "Loose card");
        String def = BoardIds.defaultOf("odeysys");

        f.boards.moveHome(Actor.CLAUDE, c.card().id(), refund);
        assertThat(f.store.find(c.card().id()).orElseThrow().boardId()).isEqualTo(refund);
        BoardActivity in = f.boards.activity(refund, 0, 10).get(0);
        assertThat(f.boards.undo(Actor.USER, refund, in.id()).outcome()).isEqualTo(BoardOutcome.OK);
        assertThat(f.store.find(c.card().id()).orElseThrow().boardId()).isEqualTo(def);

        String other = f.boards.create(Actor.USER, new NewBoard("crm", "Elsewhere", List.of(), null, false, null)).board().id();
        assertThat(f.boards.moveHome(Actor.USER, c.card().id(), other).outcome()).isEqualTo(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID);
    }
}
