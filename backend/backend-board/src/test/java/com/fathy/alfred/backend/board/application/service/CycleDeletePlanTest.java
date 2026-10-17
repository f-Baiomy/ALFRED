package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CycleDeletePlanUseCase.Plan;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.NewBoard;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Deleting a cycle keeps what boards mention (specs/027 FR-017, US6). */
class CycleDeletePlanTest {

    @TempDir
    Path dir;
    BoardFixture f;
    CycleDeletePlanService plans;

    @BeforeEach
    void open() {
        f = new BoardFixture(dir);
        plans = new CycleDeletePlanService(f.boardModel, f.notifications);
    }

    @AfterEach
    void close() throws Exception {
        f.close();
    }

    private void card(String board, String text) {
        f.board.create(Actor.USER, new CreateCardUseCase.NewCard("odeysys", CardKind.BUG, "t", text, Set.of(), board, null, List.of()));
    }

    @Test
    void keepsTheMentionedCallsPerBoardAndLetsTheOthersGo() {
        String refund = f.boards.create(Actor.USER, new NewBoard("odeysys", "Refund", List.of("c-old"), null, false, null)).board().id();
        String sprint = f.boards.create(Actor.USER, new NewBoard("odeysys", "Sprint", List.of("c-old"), null, false, null)).board().id();
        card(refund, "@[call:in:a1@c-old|POST /refund] and @[call:in:a2@c-old|GET /refund]");
        f.briefs.putBrief(Actor.USER, refund, "see @[call:in:a1@c-old|POST /refund]");

        Plan p = plans.plan("c-old");
        assertThat(p.callIds()).containsExactlyInAnyOrder("a1", "a2");
        assertThat(p.keep()).singleElement().satisfies(k -> {
            assertThat(k.boardId()).isEqualTo(refund);
            assertThat(k.name()).isEqualTo("Refund");
            assertThat(k.callIds()).containsExactlyInAnyOrder("a1", "a2");
            assertThat(k.cards()).hasSize(1);
        });

        plans.kept("c-old");
        assertThat(f.boards.cyclesOf(refund)).containsExactly("c-old");
        assertThat(f.boards.cyclesOf(sprint)).isEmpty();
        // the live calls behind the kept copies stay out of the storage limits
        assertThat(f.board.mentionedLiveCallIds()).contains("a1", "a2");
    }

    @Test
    void nothingMentionedMeansNothingKept() {
        assertThat(plans.plan("c-none").callIds()).isEmpty();
        assertThat(plans.plan("c-none").keep()).isEmpty();
    }
}
