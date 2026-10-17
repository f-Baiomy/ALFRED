package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Post;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardActivity;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The first start after specs/027 (FR-019, SC-001): data written the old way - cards on a cycle's view, a brief and a
 * chat on that cycle, a project chat, a card on a cycle with no brief - is all reachable on exactly one board after the
 * migration, and a second run changes nothing.
 */
class BoardModelMigrationTest {

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

    private CardDetail card(String project, String cycleId, String title) {
        return f.board.create(Actor.USER, new CreateCardUseCase.NewCard(project, CardKind.BUG, title, "", Set.of(), cycleId, null, List.of()))
                .card();
    }

    @Test
    void briefedCycleBecomesABoardWithItsCardsBriefAndChat() {
        f.cyclesHere.addAll(List.of("c-refund", "c-login"));
        f.cycleNames.put("c-refund", "rec 14 Oct");
        f.cycleNames.put("c-login", "login rec");
        CardDetail onRefund = card("odeysys", "c-refund", "Voucher rounds wrong");
        CardDetail onLogin = card("odeysys", "c-login", "Lockout after 3");
        CardDetail loose = card("odeysys", null, "Slow SELECT");
        f.briefs.putBrief(Actor.USER, "c-refund", "Refund to a voucher");
        f.chat.post(Actor.USER, new ChatKey("odeysys", "c-refund"), new Post("why?", null, List.of(), null, false, null, List.of()));
        f.chat.post(Actor.USER, new ChatKey("odeysys", ""), new Post("project-wide", null, List.of(), null, false, null, List.of()));

        assertThat(f.migration.migrate()).isEqualTo(1);

        // the briefed cycle is a board with the same id, named after the cycle, related to it, home to its cards
        var refund = f.boardModel.board("c-refund").orElseThrow();
        assertThat(refund.name()).isEqualTo("rec 14 Oct");
        assertThat(refund.migratedFrom()).isEqualTo("rec 14 Oct");
        assertThat(f.boardModel.cyclesOf("c-refund")).containsExactly("c-refund");
        assertThat(f.store.find(onRefund.card().id()).orElseThrow().boardId()).isEqualTo("c-refund");
        assertThat(f.briefs.brief("c-refund").text()).contains("Refund to a voucher");
        assertThat(f.boardModel.activity("c-refund", 0, 10)).extracting(BoardActivity::kind).contains(BoardActivity.Kind.MIGRATED);

        // the project's default board holds the rest, and is related to the unbriefed cycle its cards came from
        String def = BoardIds.defaultOf("odeysys");
        assertThat(f.boardModel.board(def)).isPresent();
        assertThat(f.store.find(onLogin.card().id()).orElseThrow().boardId()).isEqualTo(def);
        assertThat(f.store.find(loose.card().id()).orElseThrow().boardId()).isEqualTo(def);
        assertThat(f.boardModel.cyclesOf(def)).containsExactly("c-login");
        assertThat(f.boardModel.board("c-login")).isEmpty();

        // every card is reachable on exactly one board, own cards only
        int own = 0;
        for (String board : List.of(def, "c-refund")) {
            own += f.board.query(new CardQuery("odeysys", null, Set.of(), Set.of(), Set.of(), null, false, null, 0, 200).onBoard(board, false))
                    .cards().size();
        }
        assertThat(own).isEqualTo(3);

        // the project chat is the default board's chat
        assertThat(new ChatKey("odeysys", def)).isEqualTo(new ChatKey("odeysys", ""));
    }

    @Test
    void secondRunChangesNothing() {
        f.cyclesHere.add("c-refund");
        f.cycleNames.put("c-refund", "rec 14 Oct");
        card("odeysys", "c-refund", "Voucher rounds wrong");
        f.briefs.putBrief(Actor.USER, "c-refund", "Refund to a voucher");

        assertThat(f.migration.migrate()).isEqualTo(1);
        int boards = f.boardModel.boards(null, Set.of(), null, 100).size();
        int activity = f.boardModel.activity("c-refund", 0, 100).size();

        assertThat(f.migration.migrate()).isZero();
        assertThat(f.boardModel.boards(null, Set.of(), null, 100)).hasSize(boards);
        assertThat(f.boardModel.activity("c-refund", 0, 100)).hasSize(activity);
    }

    @Test
    void deletingTheCycleKeepsTheBoardMadeFromIt() {
        f.cyclesHere.add("c-refund");
        f.cycleNames.put("c-refund", "rec 14 Oct");
        CardDetail c = card("odeysys", "c-refund", "Voucher rounds wrong");
        f.briefs.putBrief(Actor.USER, "c-refund", "Refund to a voucher");
        f.migration.migrate();

        f.briefs.cycleRemoved("c-refund");

        assertThat(f.boardModel.board("c-refund")).isPresent();
        assertThat(f.briefs.brief("c-refund").text()).contains("Refund to a voucher");
        assertThat(f.boardModel.cyclesOf("c-refund")).isEmpty();
        assertThat(f.store.find(c.card().id()).orElseThrow().cycleDeleted()).isTrue();
    }
}
