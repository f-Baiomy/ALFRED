package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CardSummary;
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
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class BoardServiceTriageTest {

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

    private String inbox(String title) {
        return f.add(Actor.USER, "p", CardKind.BUG, title, "").card().id();
    }

    private List<ActivityKind> kinds(String id) {
        return f.board.activity(id, 0, 100).orElseThrow().entries().stream().map(ActivityEntry::kind).toList();
    }

    @Test
    void closingAsFineKeepsTheReasonAndRecordsTheResolutionLast() {
        String id = inbox("401 on health");

        CardDetail closed = f.board.close(Actor.USER, id, Resolution.FINE, "expected").card();

        assertThat(closed.card().status()).isEqualTo(CardStatus.CLOSED);
        assertThat(closed.card().resolution()).isEqualTo(Resolution.FINE);
        assertThat(closed.card().reason()).isEqualTo("expected");
        assertThat(kinds(id)).containsExactly(ActivityKind.CREATED, ActivityKind.STATUS, ActivityKind.REASON, ActivityKind.RESOLUTION);
    }

    @Test
    void notInThisFlowAlsoSetsOutOfScope() {
        String id = inbox("pricing slow");

        CardDetail closed = f.board.close(Actor.USER, id, Resolution.NOT_IN_FLOW, null).card();

        assertThat(closed.card().scope()).isEqualTo(Scope.OUT_OF_SCOPE);
        assertThat(kinds(id)).contains(ActivityKind.SCOPE);
    }

    @Test
    void aReasonCanBeAddedAfterTheClose() {
        String id = inbox("x");
        f.board.close(Actor.USER, id, Resolution.FINE, null);

        assertThat(f.board.setReason(Actor.USER, id, "later").card().card().reason()).isEqualTo("later");
        assertThat(f.board.setReason(Actor.USER, inbox("open"), "no").outcome()).isEqualTo(CardChange.Outcome.ILLEGAL_TRANSITION);
    }

    @Test
    void undoRestoresWhatTheCloseRecordedEvenAfterAReason() {
        String id = inbox("x");
        f.board.move(Actor.USER, id, CardStatus.IN_PROGRESS);
        f.board.close(Actor.USER, id, Resolution.NOT_IN_FLOW, null);
        f.board.setReason(Actor.USER, id, "oops");

        CardDetail back = f.board.undoClose(Actor.USER, id).card();

        assertThat(back.card().status()).isEqualTo(CardStatus.IN_PROGRESS);
        assertThat(back.card().resolution()).isNull();
        assertThat(back.card().scope()).isEqualTo(Scope.NOT_DECIDED);
    }

    @Test
    void undoIsRefusedAfterTheWindowOrAfterAnotherChange() {
        String late = inbox("late");
        f.board.close(Actor.USER, late, Resolution.FINE, null);
        f.clock.advanceSeconds(61);
        assertThat(f.board.undoClose(Actor.USER, late).outcome()).isEqualTo(CardChange.Outcome.CONFLICT);

        String changed = inbox("changed");
        f.board.close(Actor.USER, changed, Resolution.FINE, null);
        f.board.comment(Actor.USER, changed, new com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase.Comment(
                "a comment", null, null, null, null));
        assertThat(f.board.undoClose(Actor.USER, changed).outcome()).isEqualTo(CardChange.Outcome.CONFLICT);
    }

    @Test
    void reopeningSendsACardBackToTheInboxAndClearsItsResolution() {
        String id = inbox("x");
        f.board.close(Actor.USER, id, Resolution.WONT_FIX, "meh");

        CardDetail reopened = f.board.reopen(Actor.USER, id).card();

        assertThat(reopened.card().status()).isEqualTo(CardStatus.INBOX);
        assertThat(reopened.card().resolution()).isNull();
        assertThat(reopened.card().reason()).isNull();
        assertThat(kinds(id)).endsWith(ActivityKind.REOPENED);
    }

    @Test
    void bulkActsOnEverySelectedCardWithOneSignal() {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            ids.add(inbox("c" + i));
        }
        f.signals.clear();

        BulkCardsUseCase.BulkOutcome outcome = f.board.bulk(Actor.USER, ids, BulkCardsUseCase.Action.FINE, "all fine");

        assertThat(outcome.updated()).isEqualTo(4);
        assertThat(f.signals).containsExactly("card:p:null");
        assertThat(f.board.bulk(Actor.USER, ids, BulkCardsUseCase.Action.FINE, null).updated()).isZero();
        assertThat(f.board.bulk(Actor.USER, Collections.nCopies(201, "x"), BulkCardsUseCase.Action.TO_DO, null).outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
        String open = inbox("open");
        assertThat(f.board.bulk(Actor.USER, List.of(open), BulkCardsUseCase.Action.MARK_URGENT, null).updated()).isEqualTo(1);
        assertThat(f.board.get(open).orElseThrow().card().flags()).containsExactly(Flag.URGENT);
    }

    @Test
    void anInboxCardThatLooksLikeAClosedOneCarriesTheHint() {
        f.signatures.put("a", "4xx|GET /health");
        f.signatures.put("b", "4xx|GET /health");
        String closed = f.create(Actor.USER, "p", "401 on health", List.of(new MentionRef(MentionType.CALL, "in:a", "x"))).card().card().id();
        f.board.close(Actor.USER, closed, Resolution.FINE, "expected");
        String fresh = f.create(Actor.USER, "p", "401 again", List.of(new MentionRef(MentionType.CALL, "in:b", "x"))).card().card().id();

        CardSummary row = f.board.query(new CardQuery("p", null, null, java.util.Set.of(CardStatus.INBOX), null, null, false, null, 0, 50))
                .cards().get(0);

        assertThat(row.card().id()).isEqualTo(fresh);
        assertThat(row.similarClosed()).isNotNull();
        assertThat(row.similarClosed().number()).isEqualTo(1);
        assertThat(row.similarClosed().reason()).isEqualTo("expected");
        assertThat(f.board.get(fresh).orElseThrow().similarClosed()).isNotNull();
    }
}
