package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.Regression;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.StepState;
import com.fathy.alfred.backend.board.domain.model.TestStep;
import com.fathy.alfred.backend.board.domain.model.Waiting;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/015 phases 2-4: live step, session log, test steps, spec items, blocked by, merge and reopen proposals, regressions. */
class BoardManageTest {

    private static final String SPEC = "# ODY\n## Acceptance\n1. Branch offers only its own PCCs\n2. Import works\n";
    private static final String BRIEF = "Import PNR\n## Test steps\n1. Open import\n2. Pick a PCC\n3. Import\n";

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

    private String card(String title) {
        return f.add(Actor.USER, "p", CardKind.BUG, title, "").card().id();
    }

    private int number(String id) {
        return f.board.get(id).orElseThrow().card().number();
    }

    @Test
    void theLiveStripCarriesClaudesCurrentStep() {
        AgentStatus s = f.agent.update("p", "cy", AgentStatus.State.WATCHING, 34, 3, "reviewing ODY-482 · 34/120 calls");
        assertThat(s.step()).isEqualTo("reviewing ODY-482 · 34/120 calls");
        assertThat(f.agent.update("p", "cy", AgentStatus.State.WATCHING, 1, 0).step()).isNull();
    }

    @Test
    void aSessionLogKeepsOneEntryPerRunNewestFirst() {
        assertThat(f.briefs.append(Actor.CLAUDE, "cy", "alfred-review", "Checked 120 calls", "2 new cards", "triage")).isNotNull();
        f.clock.advanceSeconds(5);
        f.briefs.append(Actor.CLAUDE, "cy", "alfred-sync", "Logged answers", "1 card", "fix #11");
        assertThat(f.briefs.log("cy", 10)).extracting(e -> e.skill()).containsExactly("alfred-sync", "alfred-review");
        assertThat(f.briefs.append(Actor.CLAUDE, "cy", "x", "", "f", "n")).isNull();
    }

    @Test
    void testStepsComeFromTheBriefAndKeepWhatTheCycleShowed() {
        f.briefs.putBrief(Actor.USER, "cy", BRIEF);
        List<TestStep> steps = f.briefs.steps("cy");
        assertThat(steps).extracting(TestStep::text).containsExactly("Open import", "Pick a PCC", "Import");
        assertThat(steps).allMatch(s -> s.state() == StepState.UNTESTED);

        f.briefs.mark(Actor.CLAUDE, "cy", steps.get(1).key(), StepState.FAILED, 1, 11, "409");
        TestStep second = f.briefs.steps("cy").get(1);
        assertThat(second.state()).isEqualTo(StepState.FAILED);
        assertThat(second.cardNumber()).isEqualTo(11);
        assertThat(f.briefs.mark(Actor.CLAUDE, "cy", "nope", StepState.SEEN, 0, null, null).outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
    }

    @Test
    void aCardLinkedToAnAcceptanceItemShowsOnBothSides() {
        f.briefs.put(Actor.USER, "cy", "spec.md", SPEC);
        String key = f.briefs.checklist("cy").get(0).items().get(0).key();
        String id = card("PCC 409");

        var linked = f.board.linkSpecItem(Actor.CLAUDE, id, "cy", "spec.md", key);

        assertThat(linked.card().specItems()).extracting(s -> s.text()).containsExactly("Branch offers only its own PCCs");
        assertThat(f.briefs.checklist("cy").get(0).items().get(0).cards()).extracting(c -> c.title()).containsExactly("PCC 409");
        assertThat(f.board.linkSpecItem(Actor.CLAUDE, id, "cy", "spec.md", "missing").outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
    }

    @Test
    void aBlockedCardListsItsBlocker_andTwoCardsCannotBlockEachOther() {
        String fix = card("Discount not saved");
        String blocked = card("Old PCC kept");

        var out = f.board.block(Actor.USER, blocked, number(fix));
        assertThat(out.card().blockedBy()).extracting(r -> r.title()).containsExactly("Discount not saved");
        assertThat(f.board.block(Actor.USER, fix, number(blocked)).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.unblock(Actor.USER, blocked, number(fix)).card().blockedBy()).isEmpty();
    }

    @Test
    void acceptingAMergeMovesTheHistoryAndClosesTheDuplicate() {
        String target = card("read-pnr 409");
        String dup = card("409 again");
        f.board.comment(Actor.USER, dup, new CommentOnCardUseCase.Comment("seen on branch 12", null, null, null, null));
        f.board.link(Actor.USER, dup, new MentionRef(MentionType.CALL, "in:c9", "POST /read-pnr · 409"));

        var proposed = f.board.proposeMerge(Actor.CLAUDE, dup, number(target), "same signature", "");
        assertThat(proposed.card().proposal().target()).isEqualTo("MERGE:#" + number(target));
        var merged = f.board.acceptProposal(Actor.USER, dup);

        assertThat(merged.card().card().id()).isEqualTo(target);
        assertThat(merged.card().links()).extracting(MentionRef::ref).contains("in:c9");
        List<ActivityEntry> history = f.board.activity(target, 0, 100).orElseThrow().entries();
        assertThat(history).extracting(ActivityEntry::text).contains("seen on branch 12");
        assertThat(history).extracting(ActivityEntry::kind).contains(ActivityKind.MERGED);
        var closed = f.board.get(dup).orElseThrow().card();
        assertThat(closed.resolution()).isEqualTo(Resolution.DUPLICATE);
        assertThat(closed.reason()).isEqualTo("merged into #" + number(target));
    }

    @Test
    void aMergeIsProposedOnlyByClaudeIntoAnotherOpenCardOfTheProject() {
        String a = card("A");
        assertThat(f.board.proposeMerge(Actor.USER, a, 99, "", "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.proposeMerge(Actor.CLAUDE, a, number(a), "", "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.proposeMerge(Actor.CLAUDE, a, 99, "", "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void aRegressionIsFoundAndAcceptingTheReopenSendsTheCardBackToToDo() {
        f.signatures.put("c1", "5xx|POST /loginAction");
        String id = f.create(Actor.USER, "p", "Login 500", List.of(new MentionRef(MentionType.CALL, "in:c1", "POST /loginAction · 500"))).card().card().id();
        f.board.move(Actor.USER, id, CardStatus.TO_DO);
        f.board.move(Actor.USER, id, CardStatus.DONE);
        f.clock.advanceSeconds(3600);
        f.liveCalls.add(new CycleCall("in", "r1", "POST", "/loginAction", 500, "5xx|POST /loginAction", f.clock.instant()));
        f.liveCalls.add(new CycleCall("in", "r2", "POST", "/loginAction", 200, "ok|POST /loginAction", f.clock.instant()));

        List<Regression> found = f.insights.regressions("p");
        assertThat(found).extracting(Regression::title).containsExactly("Login 500");
        assertThat(found.get(0).calls()).extracting(s -> s.ref()).containsExactly("in:r1");

        f.board.proposeReopen(Actor.CLAUDE, id, "fails again", "@[call:in:r1|POST /loginAction · 500]");
        var reopened = f.board.acceptProposal(Actor.USER, id);
        assertThat(reopened.card().card().status()).isEqualTo(CardStatus.TO_DO);
        assertThat(reopened.card().waiting().who()).isEqualTo(Waiting.CLAUDE);
    }

    @Test
    void aCallFromBeforeTheCardWasDoneIsNoRegression() {
        f.signatures.put("c1", "5xx|POST /x");
        f.liveCalls.add(new CycleCall("in", "old", "POST", "/x", 500, "5xx|POST /x", f.clock.instant().minusSeconds(60)));
        String id = f.create(Actor.USER, "p", "X 500", List.of(new MentionRef(MentionType.CALL, "in:c1", "POST /x · 500"))).card().card().id();
        f.board.move(Actor.USER, id, CardStatus.DONE);
        assertThat(f.insights.regressions("p")).isEmpty();
    }
}
