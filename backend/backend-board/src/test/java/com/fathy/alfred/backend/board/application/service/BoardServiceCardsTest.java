package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.Scope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class BoardServiceCardsTest {

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

    private List<ActivityEntry> history(String id) {
        return f.board.activity(id, 0, 100).orElseThrow().entries();
    }

    @Test
    void aNewCardGetsTheNextNumberLandsInTheInboxAndRecordsItsCreation() {
        CardDetail first = f.add(Actor.USER, "odeysys", CardKind.BUG, "Discount not saved", "");
        CardDetail second = f.add(Actor.USER, "odeysys", CardKind.TASK, "Retry email", "");

        assertThat(first.card().number()).isEqualTo(1);
        assertThat(second.card().number()).isEqualTo(2);
        assertThat(first.card().status()).isEqualTo(CardStatus.INBOX);
        assertThat(history(first.card().id())).extracting(ActivityEntry::kind).containsExactly(ActivityKind.CREATED);
        assertThat(f.signals).contains("card:odeysys:null");
    }

    @Test
    void quickAddParsesKindTitleAndFlags() {
        CardChange change = f.board.quickAdd(Actor.USER, "p", null, "bug! discount not saved #urgent");

        assertThat(change.card().card().kind()).isEqualTo(CardKind.BUG);
        assertThat(change.card().card().title()).isEqualTo("discount not saved");
        assertThat(change.card().card().flags()).containsExactly(Flag.URGENT);
        assertThat(f.board.quickAdd(Actor.USER, "p", null, "bug! #urgent").outcome()).isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void anUpdateChangesOnlyTheFieldsItCarriesAndRecordsEachOne() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "Old title", "").card().id();
        f.board.update(Actor.USER, id, new UpdateCardUseCase.CardEdit("New title", null, null, null, null, null, null));
        f.board.update(Actor.USER, id, new UpdateCardUseCase.CardEdit(null, null, null, Set.of(Flag.RISK), Scope.IN_SCOPE, null, null));

        CardDetail now = f.board.get(id).orElseThrow();
        assertThat(now.card().title()).isEqualTo("New title");
        assertThat(now.card().flags()).containsExactly(Flag.RISK);
        assertThat(now.card().scope()).isEqualTo(Scope.IN_SCOPE);
        assertThat(history(id)).extracting(ActivityEntry::kind)
                .containsExactly(ActivityKind.CREATED, ActivityKind.TITLE, ActivityKind.FLAGS, ActivityKind.SCOPE);
        assertThat(history(id).get(1).oldValue()).isEqualTo("Old title");
        assertThat(history(id).get(1).newValue()).isEqualTo("New title");
    }

    @Test
    void movesFollowTheTransitionsAndAreRecorded() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();

        assertThat(f.board.move(Actor.USER, id, CardStatus.IN_PROGRESS).outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.board.move(Actor.USER, id, CardStatus.CLOSED).outcome()).isEqualTo(CardChange.Outcome.ILLEGAL_TRANSITION);
        assertThat(f.board.move(Actor.USER, "nope", CardStatus.DONE).outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
        ActivityEntry move = history(id).get(1);
        assertThat(move.kind()).isEqualTo(ActivityKind.STATUS);
        assertThat(move.oldValue()).isEqualTo("INBOX");
        assertThat(move.newValue()).isEqualTo("IN_PROGRESS");
    }

    @Test
    void deletingRemovesTheCardButNotItsNumber() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();

        assertThat(f.board.delete(Actor.USER, id).outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.board.get(id)).isEmpty();
        assertThat(f.add(Actor.USER, "p", CardKind.BUG, "next", "").card().number()).isEqualTo(2);
        assertThat(f.signals).contains("deleted:p:null");
    }

    @Test
    void theListIsClampedAndCountsProgress() {
        for (int i = 0; i < 3; i++) {
            f.add(Actor.USER, "p", CardKind.TASK, "t" + i, "");
        }
        var page = f.board.query(new CardQuery("p", null, null, null, null, null, false, null, -5, 100_000));

        assertThat(page.cards()).hasSize(3);
        assertThat(page.total()).isEqualTo(3);
        assertThat(page.counts().open()).isEqualTo(3);
        assertThat(new CardQuery("p", null, null, null, null, null, false, null, -5, 100_000).limit()).isEqualTo(CardQuery.MAX_LIMIT);
    }

    // --------------------------------------------------------------------------------------------- Claude's limits

    @Test
    void claudesCardsAlwaysLandInTheInbox() {
        CardChange change = f.board.create(Actor.CLAUDE, new CreateCardUseCase.NewCard("p", CardKind.BUG, "found it", "", Set.of(), null,
                CardStatus.DONE, List.of()));

        assertThat(change.card().card().status()).isEqualTo(CardStatus.INBOX);
        assertThat(change.card().card().author()).isEqualTo(Actor.CLAUDE);
    }

    @Test
    void claudeMovesOnlyIntoToDoInProgressAndFixedAndNeverSetsScope() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();

        assertThat(f.board.move(Actor.CLAUDE, id, CardStatus.FIXED).outcome()).isEqualTo(CardChange.Outcome.OK);
        CardChange verified = f.board.move(Actor.CLAUDE, id, CardStatus.VERIFIED);
        assertThat(verified.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(verified.message()).isEqualTo(ClaudeRules.USER_ONLY);
        assertThat(f.board.update(Actor.CLAUDE, id, new UpdateCardUseCase.CardEdit(null, null, null, null, Scope.IN_SCOPE, null, null))
                .outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.update(Actor.CLAUDE, id, new UpdateCardUseCase.CardEdit(null, null, null, Set.of(Flag.RISK), null, null, null))
                .outcome()).isEqualTo(CardChange.Outcome.OK);
    }

    @Test
    void claudeClosesWithAReasonOrDeletesOnlyInboxCards() {
        String inbox = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();
        assertThat(f.board.close(Actor.CLAUDE, inbox, Resolution.FINE, null).message()).isEqualTo(ClaudeRules.SAY_WHY);
        assertThat(f.board.close(Actor.CLAUDE, inbox, Resolution.DUPLICATE, "same as #1").message()).isEqualTo(ClaudeRules.MERGE_INSTEAD);
        CardChange closed = f.board.close(Actor.CLAUDE, inbox, Resolution.WONT_FIX, "outside this board");
        assertThat(closed.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(closed.card().card().status()).isEqualTo(CardStatus.CLOSED);
        assertThat(closed.card().card().reason()).isEqualTo("outside this board");

        String other = f.add(Actor.USER, "p", CardKind.BUG, "u", "").card().id();
        assertThat(f.board.delete(Actor.CLAUDE, other).outcome()).isEqualTo(CardChange.Outcome.OK);

        String todo = f.add(Actor.USER, "p", CardKind.BUG, "v", "").card().id();
        f.board.move(Actor.USER, todo, CardStatus.TO_DO);
        CardChange refused = f.board.close(Actor.CLAUDE, todo, Resolution.FINE, "x");
        assertThat(refused.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(refused.message()).isEqualTo(ClaudeRules.INBOX_ONLY);
        assertThat(f.board.delete(Actor.CLAUDE, todo).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void claudeCannotCloseReopenDeleteBulkOrUndo() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();
        f.board.move(Actor.USER, id, CardStatus.TO_DO);

        assertThat(f.board.close(Actor.CLAUDE, id, Resolution.FINE, "x").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.delete(Actor.CLAUDE, id).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.bulk(Actor.CLAUDE, List.of(id), com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase.Action.FINE,
                null).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        f.board.close(Actor.USER, id, Resolution.FINE, null);
        assertThat(f.board.reopen(Actor.CLAUDE, id).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.setReason(Actor.CLAUDE, id, "x").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.undoClose(Actor.CLAUDE, id).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    /** A card the user closed as Fine over call c1 of GET /health; c2 is another 401 of the same endpoint. */
    private void dismissedHealthCard(String title) {
        f.signatures.put("c1", "4xx|GET /health");
        f.signatures.put("c2", "4xx|GET /health");
        String dismissed = f.create(Actor.USER, "p", title, List.of(new MentionRef(MentionType.CALL, "in:c1", "GET /health · 401")))
                .card().card().id();
        f.board.close(Actor.USER, dismissed, Resolution.FINE, "health needs no session");
    }

    @Test
    void claudeIsRefusedACardThatNamesTheSameCallAsOneTheUserDismissed() {
        dismissedHealthCard("401 on /health");

        // a title that shares nothing with the dismissed one, but the very call the user dismissed
        CardChange again = f.create(Actor.CLAUDE, "p", "Probe rejected", List.of(new MentionRef(MentionType.CALL, "in:c1", "GET /health · 401")));

        assertThat(again.outcome()).isEqualTo(CardChange.Outcome.DUPLICATE_OF_CLOSED);
        assertThat(again.message()).contains("#1").contains("Fine - not an issue").contains("health needs no session");
        // the user may still add it
        assertThat(f.create(Actor.USER, "p", "401 again", List.of(new MentionRef(MentionType.CALL, "in:c1", "x"))).outcome())
                .isEqualTo(CardChange.Outcome.OK);
    }

    @Test
    void aSharedCallHidesOnlyACardOfTheSameKind() {
        // 61813's #39: a NOTE about slow searches, closed as Fine (a debugger pause), linked to the search calls
        f.signatures.put("s1", "ok|POST /refunded-requests/search");
        String note = f.board.create(Actor.USER, new CreateCardUseCase.NewCard("p", CardKind.NOTE,
                "Refunded Requests search stalls 3.8 s to 52 s before its first SQL", "", Set.of(), null, null,
                List.of(new MentionRef(MentionType.CALL, "in:s1", "POST search · 200")))).card().card().id();
        f.board.close(Actor.USER, note, Resolution.FINE, "a debugger pause");
        List<MentionRef> sameCall = List.of(new MentionRef(MentionType.CALL, "in:s1", "POST search · 200"));

        // the same searches lack a feature, or answer wrong: other problems, other kinds - added, with no "Looks like #1"
        CardChange task = f.board.create(Actor.CLAUDE, new CreateCardUseCase.NewCard("p", CardKind.TASK,
                "Missing feature: Branch dropdown is not multi-select", "", Set.of(), null, null, sameCall));
        assertThat(task.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(task.card().similarClosed()).isNull();
        assertThat(f.board.getByNumber("p", task.card().card().number()).orElseThrow().similarClosed()).isNull();
        assertThat(f.board.query(new CardQuery("p", null, null, null, null, null, false, null, 0, 500)).cards().stream().filter(c -> c.card().kind() == CardKind.TASK)
                .findFirst().orElseThrow().similarClosed()).isNull();
        // another kind whose title names the dismissed problem still shows the hint
        CardChange stalls = f.board.create(Actor.CLAUDE, new CreateCardUseCase.NewCard("p", CardKind.QUESTION,
                "Do the stalls come back without the debugger?", "", Set.of(), null, null, sameCall));
        assertThat(stalls.card().similarClosed()).isNotNull();
        assertThat(f.board.create(Actor.CLAUDE, new CreateCardUseCase.NewCard("p", CardKind.BUG,
                "Wrong result: All Agencies returns no rows", "", Set.of(), null, null, sameCall)).outcome())
                .isEqualTo(CardChange.Outcome.OK);
        // another NOTE over the very call the user dismissed is that note again
        assertThat(f.board.create(Actor.CLAUDE, new CreateCardUseCase.NewCard("p", CardKind.NOTE,
                "Waits before validateRequest", "", Set.of(), null, null, sameCall)).outcome())
                .isEqualTo(CardChange.Outcome.DUPLICATE_OF_CLOSED);
    }

    @Test
    void theSameCallCapturedInACycleIsStillTheSameCall() {
        dismissedHealthCard("401 on /health");

        CardChange again = f.create(Actor.CLAUDE, "p", "Probe rejected", List.of(new MentionRef(MentionType.CALL, "in:c1@cycle-9", "GET /health · 401")));

        assertThat(again.outcome()).isEqualTo(CardChange.Outcome.DUPLICATE_OF_CLOSED);
    }

    @Test
    void aCallOnlyMentionedInTheDismissedCardsCommentCountsAsItsCall() {
        f.signatures.put("c1", "4xx|GET /health");
        f.signatures.put("c3", "4xx|GET /health");
        String dismissed = f.create(Actor.USER, "p", "401 on /health", List.of(new MentionRef(MentionType.CALL, "in:c1", "x"))).card().card().id();
        f.board.comment(Actor.USER, dismissed, new CommentOnCardUseCase.Comment("again at @[call:in:c3|GET /health · 401]", null, null, null, null));
        f.board.close(Actor.USER, dismissed, Resolution.NOT_IN_FLOW, null);

        CardChange again = f.create(Actor.CLAUDE, "p", "Probe rejected", List.of(new MentionRef(MentionType.CALL, "in:c3", "x")));

        assertThat(again.outcome()).isEqualTo(CardChange.Outcome.DUPLICATE_OF_CLOSED);
        assertThat(again.message()).contains("Not in this flow");
    }

    @Test
    void claudeIsRefusedACardWhoseTitleSharesTwoWordsWithTheDismissedOne() {
        dismissedHealthCard("401 on health endpoint without session");

        // another call (c2), but "endpoint" and "session" are the dismissed card's own words
        CardChange again = f.create(Actor.CLAUDE, "p", "Health endpoint answers 401 without session", List.of(new MentionRef(MentionType.CALL, "in:c2", "GET /health · 401")));

        assertThat(again.outcome()).isEqualTo(CardChange.Outcome.DUPLICATE_OF_CLOSED);
        assertThat(again.message()).contains("#1").contains("401 on health endpoint");
    }

    @Test
    void wordsThatOnlyNameTheEndpointDoNotMakeACardTheDismissedOne() {
        f.signatures.put("c1", "ok|POST /flight/search");
        f.signatures.put("c2", "ok|POST /flight/search");
        String dismissed = f.create(Actor.USER, "p", "Flight search slow", List.of(new MentionRef(MentionType.CALL, "in:c1", "x"))).card().card().id();
        f.board.close(Actor.USER, dismissed, Resolution.FINE, "supplier time");

        // "flight" and "search" are the endpoint's words: every finding on it shares them - this one is new
        CardChange other = f.create(Actor.CLAUDE, "p", "Flight search answers empty result for a valid route", List.of(new MentionRef(MentionType.CALL, "in:c2", "x")));

        assertThat(other.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(other.card().similarClosed()).isNotNull();
        assertThat(other.card().similarClosed().number()).isEqualTo(1);
    }

    @Test
    void aRepeatOnAnotherCallWithOneSharedWordIsCreatedAndShowsTheClosedCardAsAHint() {
        dismissedHealthCard("401 on health endpoint");

        CardChange other = f.create(Actor.CLAUDE, "p", "Health probe slow", List.of(new MentionRef(MentionType.CALL, "in:c2", "GET /health · 401")));

        assertThat(other.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(other.card().similarClosed()).isNotNull();
        assertThat(other.card().similarClosed().number()).isEqualTo(1);
        assertThat(other.card().similarClosed().resolution()).isEqualTo(Resolution.FINE);
    }

    @Test
    void aRepeatOnAnotherCallSharingNoWordIsCreatedToo() {
        dismissedHealthCard("401 on /health");

        CardChange other = f.create(Actor.CLAUDE, "p", "401 again", List.of(new MentionRef(MentionType.CALL, "in:c2", "GET /health · 401")));

        assertThat(other.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(other.card().similarClosed()).isNotNull();
        assertThat(other.card().similarClosed().reason()).isEqualTo("health needs no session");
    }

    @Test
    void aCardWithNoCallOfItsOwnIsNeverASignatureRepeat() {
        dismissedHealthCard("401 on health endpoint");

        // no mention, so no signature: the title alone never refuses
        assertThat(f.create(Actor.CLAUDE, "p", "Health endpoint answers 401 again", List.of()).outcome()).isEqualTo(CardChange.Outcome.OK);
    }

    @Test
    void aWontFixCardDoesNotBlockClaude() {
        f.signatures.put("c1", "5xx|GET /pricing");
        String slow = f.create(Actor.USER, "p", "slow pricing", List.of(new MentionRef(MentionType.CALL, "in:c1", "x"))).card().card().id();
        f.board.close(Actor.USER, slow, Resolution.WONT_FIX, null);

        assertThat(f.create(Actor.CLAUDE, "p", "pricing", List.of(new MentionRef(MentionType.CALL, "in:c1", "x"))).outcome())
                .isEqualTo(CardChange.Outcome.OK);
    }

    @Test
    void claudeAddsNothingWhileTheBoardIsPaused() {
        f.agent.update("p", null, AgentStatus.State.WATCHING, 1, 0);
        f.agent.setState("p", AgentStatus.State.PAUSED);

        assertThat(f.add(Actor.USER, "p", CardKind.BUG, "the user still can", "")).isNotNull();
        assertThat(f.create(Actor.CLAUDE, "p", "claude", List.of()).outcome()).isEqualTo(CardChange.Outcome.PAUSED);
    }
}
