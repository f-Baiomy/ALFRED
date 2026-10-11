package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.NextSteps;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.Waiting;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * specs/015 FR-1..FR-3 and FR-6: who a card waits on - set by Alfred on events and by Claude in a comment - the
 * next-step summary, and briefs / spec files written by Claude with the replaced version kept for Restore previous.
 */
class BoardWaitingTest {

    @TempDir
    Path dir;

    private BoardFixture f;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private Waiting waiting(String id) {
        return f.board.get(id).orElseThrow().waiting() == null ? null : f.board.get(id).orElseThrow().waiting().who();
    }

    private long ask(String id, String q) {
        return f.board.comment(Actor.CLAUDE, id, new CommentOnCardUseCase.Comment(null, null, null, null, null, null, q)).entry().id();
    }

    private void answer(String id, long question) {
        f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("yes", null, null, null, null, null, null, question, true));
    }

    @Test
    void aCardWaitsOnTheUserUntilEveryQuestionIsAnsweredThenOnClaude() {
        String id = f.add(Actor.CLAUDE, "p", CardKind.QUESTION, "Vouchers", "").card().id();
        assertThat(waiting(id)).as("a finding waits to be sorted").isEqualTo(Waiting.USER);
        long q1 = ask(id, "Stack them?");
        long q2 = ask(id, "Max two?");
        answer(id, q1);
        assertThat(waiting(id)).isEqualTo(Waiting.USER);
        answer(id, q2);
        assertThat(waiting(id)).isEqualTo(Waiting.CLAUDE);
    }

    @Test
    void movesSetWhoIsNext() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "A", "").card().id();
        assertThat(waiting(id)).as("a card the user wrote waits on nobody yet").isNull();
        f.board.move(Actor.USER, id, CardStatus.TO_DO);
        assertThat(waiting(id)).isEqualTo(Waiting.CLAUDE);
        f.board.move(Actor.CLAUDE, id, CardStatus.FIXED);
        assertThat(waiting(id)).isEqualTo(Waiting.RETEST);
        f.board.propose(Actor.CLAUDE, id, CardStatus.VERIFIED, null, "", "");
        assertThat(waiting(id)).isEqualTo(Waiting.USER);
        f.board.acceptProposal(Actor.USER, id);
        assertThat(waiting(id)).isEqualTo(Waiting.NONE);
        f.board.close(Actor.USER, id, Resolution.WONT_FIX, null);
        f.board.reopen(Actor.USER, id);
        assertThat(waiting(id)).isEqualTo(Waiting.USER);
    }

    @Test
    void claudeSetsItInAComment_andTheSinceTimeStaysWhileItDoesNotChange() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "A", "").card().id();
        f.board.comment(Actor.CLAUDE, id, new CommentOnCardUseCase.Comment(null, "Looked", "Need a log", "Waiting for a re-test", null, null,
                null, null, false, Waiting.RETEST));
        var first = f.board.get(id).orElseThrow().waiting();
        f.clock.advanceSeconds(3600);
        f.board.comment(Actor.CLAUDE, id, new CommentOnCardUseCase.Comment(null, "Still", "same", "re-test", null, null, null, null, false,
                Waiting.RETEST));
        assertThat(f.board.get(id).orElseThrow().waiting()).isEqualTo(first);
    }

    @Test
    void theBoardFiltersByWhoACardWaitsOn() {
        String mine = f.add(Actor.CLAUDE, "p", CardKind.BUG, "for the user", "").card().id();
        String claudes = f.add(Actor.USER, "p", CardKind.BUG, "for Claude", "").card().id();
        f.board.move(Actor.USER, claudes, CardStatus.TO_DO);

        var page = f.board.query(new CardQuery("p", null, Set.of(), Set.of(), Set.of(), null, false, null, 0, 50, false, null, false, Waiting.USER));

        assertThat(page.cards()).extracting(c -> c.card().id()).containsExactly(mine);
        assertThat(page.cards().get(0).waiting().who()).isEqualTo(Waiting.USER);
    }

    @Test
    void nextStepsListWhatWaitsOnTheUserOldestFirstWithWhy() {
        String inbox = f.add(Actor.CLAUDE, "p", CardKind.BUG, "sort me", "").card().id();
        f.clock.advanceSeconds(60);
        String question = f.add(Actor.USER, "p", CardKind.QUESTION, "answer me", "").card().id();
        ask(question, "which?");
        String todo = f.add(Actor.USER, "p", CardKind.BUG, "fix me", "").card().id();
        f.board.move(Actor.USER, todo, CardStatus.TO_DO);

        NextSteps steps = f.insights.nextSteps("p", null);

        assertThat(steps.waitingOnUser()).extracting(NextSteps.Item::title, NextSteps.Item::why)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("sort me", "inbox"), org.assertj.core.groups.Tuple.tuple("answer me", "question"));
        assertThat(steps.waitingOnClaude()).isEqualTo(1);
        assertThat(steps.toDo()).isEqualTo(1);
        assertThat(steps.inbox()).isEqualTo(2);
        assertThat(inbox).isNotNull();
    }

    @Test
    void claudeWritesTheBriefAndASpec_theUserRestoresThePreviousVersion() {
        f.briefs.putBrief(Actor.USER, "cy", "mine");
        f.briefs.putBrief(Actor.CLAUDE, "cy", "Claude's");
        assertThat(f.briefs.brief("cy").updatedBy()).isEqualTo(Actor.CLAUDE);

        assertThat(f.briefs.restoreBrief(Actor.CLAUDE, "cy").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        var restored = f.briefs.restoreBrief(Actor.USER, "cy");
        assertThat(restored.brief().text()).isEqualTo("mine");
        assertThat(restored.brief().updatedBy()).isEqualTo(Actor.USER);
        assertThat(f.briefs.restoreBrief(Actor.USER, "cy").brief().text()).as("a second restore undoes the first").isEqualTo("Claude's");

        f.briefs.put(Actor.USER, "cy", "spec.md", "v1");
        var replaced = f.briefs.put(Actor.CLAUDE, "cy", "spec.md", "v2");
        assertThat(replaced.file().uploadedBy()).isEqualTo(Actor.CLAUDE);
        assertThat(f.briefs.specs("cy").get(0).hasPrevious()).isTrue();
        assertThat(f.briefs.restore(Actor.USER, "cy", "spec.md").outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.briefs.spec("cy", "spec.md").orElseThrow().content()).isEqualTo("v1");
        assertThat(f.briefs.restore(Actor.USER, "cy", "other.md").outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
    }
}
