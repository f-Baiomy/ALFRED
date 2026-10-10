package com.fathy.alfred.backend.board.application.service;

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
    void claudeCannotCloseReopenDeleteBulkOrUndo() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();

        assertThat(f.board.close(Actor.CLAUDE, id, Resolution.FINE, null).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.delete(Actor.CLAUDE, id).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.bulk(Actor.CLAUDE, List.of(id), com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase.Action.FINE,
                null).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        f.board.close(Actor.USER, id, Resolution.FINE, null);
        assertThat(f.board.reopen(Actor.CLAUDE, id).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.setReason(Actor.CLAUDE, id, "x").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.undoClose(Actor.CLAUDE, id).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void claudeIsRefusedACardThatRepeatsOneTheUserDismissed() {
        f.signatures.put("c1", "4xx|GET /health");
        f.signatures.put("c2", "4xx|GET /health");
        MentionRef first = new MentionRef(MentionType.CALL, "in:c1", "GET /health · 401");
        String dismissed = f.create(Actor.USER, "p", "401 on /health", List.of(first)).card().card().id();
        f.board.close(Actor.USER, dismissed, Resolution.FINE, "health needs no session");

        CardChange again = f.create(Actor.CLAUDE, "p", "401 again", List.of(new MentionRef(MentionType.CALL, "in:c2", "GET /health · 401")));

        assertThat(again.outcome()).isEqualTo(CardChange.Outcome.DUPLICATE_OF_CLOSED);
        assertThat(again.message()).contains("#1").contains("Fine - not an issue").contains("health needs no session");
        // the user may still add it
        assertThat(f.create(Actor.USER, "p", "401 again", List.of(new MentionRef(MentionType.CALL, "in:c2", "x"))).outcome())
                .isEqualTo(CardChange.Outcome.OK);
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
