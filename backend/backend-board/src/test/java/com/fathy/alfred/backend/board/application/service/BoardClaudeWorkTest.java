package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.SearchCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardSearchHit;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.FixCheck;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.Mark;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What Claude needs to work on the board from anywhere: search across boards with the latest comment, similar cards,
 * the changes after a cursor and the wake-up for the next one, replies and questions, editing only its own Inbox
 * cards, proposals and suggested checklist marks the user accepts or dismisses, and the fix check against a cycle.
 */
class BoardClaudeWorkTest {

    private static final String SPEC = "# ODY-482\n## Acceptance\n1. POST /orders returns 201\n2. ORDERS.discount is stored\n";

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

    private String card(String project, String title) {
        return f.add(Actor.USER, project, CardKind.BUG, title, "").card().id();
    }

    private static CommentOnCardUseCase.Comment didFoundNext(String did) {
        return new CommentOnCardUseCase.Comment(null, did, "found", "next", null);
    }

    private static CardQuery everywhere(Set<CardStatus> statuses, boolean claudeTouched) {
        return new CardQuery("", null, Set.of(), statuses, Set.of(), null, false, null, 0, 100, true, null, claudeTouched);
    }

    // ----------------------------------------------------------------------------------------------------------- search

    @Test
    void searchFindsCardsOnEveryBoardWithTheirLatestCommentInFull() {
        String a = card("shop", "Discount lost");
        String b = card("admin", "Login loops");
        card("admin", "Untouched");
        String longFound = "x".repeat(5000);
        f.board.comment(Actor.CLAUDE, a, didFoundNext("first"));
        f.board.comment(Actor.CLAUDE, a, new CommentOnCardUseCase.Comment(null, "second", longFound, "n", null));
        f.board.move(Actor.CLAUDE, b, CardStatus.TO_DO);
        f.board.move(Actor.CLAUDE, b, CardStatus.IN_PROGRESS);

        SearchCardsUseCase.SearchPage mine = f.insights.search(everywhere(Set.of(), true));

        assertThat(mine.cards()).extracting(h -> h.card().title()).containsExactlyInAnyOrder("Discount lost", "Login loops");
        CardSearchHit discount = mine.cards().stream().filter(h -> h.card().id().equals(a)).findFirst().orElseThrow();
        assertThat(discount.lastComment().text()).contains("**Did** second").contains(longFound);
        assertThat(discount.commentCount()).isEqualTo(2);
        assertThat(f.insights.search(everywhere(Set.of(CardStatus.IN_PROGRESS), false)).cards())
                .extracting(h -> h.card().project()).containsExactly("admin");
    }

    @Test
    void searchKeepsCardsChangedSinceATime() {
        card("p", "old");
        f.clock.advanceSeconds(60);
        Instant cut = f.clock.instant();
        card("p", "new");

        var page = f.insights.search(new CardQuery("", null, Set.of(), Set.of(), Set.of(), null, false, null, 0, 100, true, cut, false));

        assertThat(page.cards()).extracting(h -> h.card().title()).containsExactly("new");
    }

    @Test
    void similarCardsShareTheSignatureOrTitleWords() {
        f.signatures.put("c1", "5xx|POST /orders");
        f.signatures.put("c2", "5xx|POST /orders");
        f.create(Actor.USER, "p", "Checkout breaks", List.of(new MentionRef(MentionType.CALL, "in:c1", "POST /orders · 500")));
        card("p", "Discount voucher ignored at checkout");
        card("p", "Unrelated thing");

        List<SearchCardsUseCase.Similar> bySignature = f.insights.similar("p", null, new MentionRef(MentionType.CALL, "in:c2", "x"), 10);
        List<SearchCardsUseCase.Similar> byTitle = f.insights.similar(null, "voucher discount wrong", null, 10);

        assertThat(bySignature).extracting(s -> s.card().card().title()).containsExactly("Checkout breaks");
        assertThat(bySignature.get(0).why()).contains("5xx|POST /orders");
        assertThat(byTitle).extracting(s -> s.card().card().title()).containsExactly("Discount voucher ignored at checkout");
        assertThat(byTitle.get(0).why()).contains("discount").contains("voucher");
    }

    // ---------------------------------------------------------------------------------------------------------- changes

    @Test
    void changesAfterACursorAreEveryEntryWithItsCardAndMoveOn() {
        String id = card("p", "A");
        BoardChanges start = f.insights.changes("now", null, null, null, 100);
        f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("please look", null, null, null, null));
        f.board.move(Actor.USER, id, CardStatus.TO_DO);

        BoardChanges next = f.insights.changes(start.cursor(), null, null, null, 100);

        assertThat(next.entries()).extracting(e -> e.entry().kind()).containsExactly(ActivityKind.COMMENT, ActivityKind.STATUS);
        assertThat(next.entries().get(0).number()).isEqualTo(1);
        assertThat(next.entries().get(0).title()).isEqualTo("A");
        assertThat(f.insights.changes(next.cursor(), null, null, null, 100).isEmpty()).isTrue();
    }

    @Test
    void sinceClaudeIsWhatTheUserDidAfterClaudesLastEntry() {
        String id = card("p", "A");
        f.board.comment(Actor.CLAUDE, id, didFoundNext("looked"));
        f.clock.advanceSeconds(5);
        f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("thanks, also check B", null, null, null, null));
        f.briefs.put(Actor.USER, "cy", "spec.md", SPEC);

        BoardChanges sinceMe = f.insights.changes("claude", "p", null, Actor.USER, 100);

        assertThat(sinceMe.entries()).extracting(e -> e.entry().text()).containsExactly("thanks, also check B");
        assertThat(f.insights.changes("claude", null, null, null, 100).cycles()).extracting(BoardChanges.CycleChange::what)
                .containsExactly("spec");
    }

    @Test
    void aWaiterIsToldOnceOnTheNextChange() throws Exception {
        String id = card("p", "A");
        AtomicInteger woke = new AtomicInteger();
        AutoCloseable handle = f.insights.onNextChange(woke::incrementAndGet);

        f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("hi", null, null, null, null));
        f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("again", null, null, null, null));

        assertThat(woke.get()).isEqualTo(1);
        handle.close();
        assertThat(f.feed.waiting()).isZero();
    }

    @Test
    void anUnreadableCursorIsRefusedWithHowToFixIt() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> f.insights.changes("abc", null, null, null, 10))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("\"now\"");
    }

    // ------------------------------------------------------------------------------------------- replies, questions, edits

    @Test
    void claudeRepliesAndAsksAQuestionThatFlagsNeedsDecision() {
        String id = card("p", "A");

        f.board.comment(Actor.CLAUDE, id, new CommentOnCardUseCase.Comment(null, null, null, null, null, "It is the cache.", null));
        var asked = f.board.comment(Actor.CLAUDE, id, new CommentOnCardUseCase.Comment(null, null, null, null, null, null,
                "Should a voucher stack with a discount?"));

        List<ActivityEntry> history = f.board.activity(id, 0, 100).orElseThrow().entries();
        assertThat(history).extracting(ActivityEntry::text).contains("**Reply** It is the cache.",
                "**Question** Should a voucher stack with a discount?");
        assertThat(asked.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.board.get(id).orElseThrow().card().flags()).contains(Flag.NEEDS_DECISION);
    }

    @Test
    void claudeEditsOnlyItsOwnCardsWhileInTheInboxButMayFlagAny() {
        String users = card("p", "User's card");
        String mine = f.add(Actor.CLAUDE, "p", CardKind.BUG, "Claude's card", "").card().id();

        CardChange onUsers = f.board.update(Actor.CLAUDE, users, new UpdateCardUseCase.CardEdit("new title", null, null, null, null, null, null));
        CardChange flagUsers = f.board.update(Actor.CLAUDE, users, new UpdateCardUseCase.CardEdit(null, null, null, Set.of(Flag.RISK), null, null, null));
        CardChange onMine = f.board.update(Actor.CLAUDE, mine, new UpdateCardUseCase.CardEdit("better title", "more", null, null, null, null, null));
        f.board.move(Actor.USER, mine, CardStatus.TO_DO);
        CardChange afterSorting = f.board.update(Actor.CLAUDE, mine, new UpdateCardUseCase.CardEdit("again", null, null, null, null, null, null));

        assertThat(onUsers.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(flagUsers.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(onMine.card().card().title()).isEqualTo("better title");
        assertThat(afterSorting.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    // -------------------------------------------------------------------------------------------------------- proposals

    @Test
    void claudeProposesVerifiedAndTheUserAcceptsIt() {
        String id = card("p", "A");
        f.board.move(Actor.USER, id, CardStatus.TO_DO);
        f.board.move(Actor.USER, id, CardStatus.FIXED);

        CardChange proposed = f.board.propose(Actor.CLAUDE, id, CardStatus.VERIFIED, null, "retest passed",
                "@[call:in:c9@cy|POST /orders · 201]");
        var onTheBoard = f.board.query(new CardQuery("p", null, Set.of(), Set.of(), Set.of(), null, false, null, 0, 10)).cards().get(0);
        CardChange claudeAccepts = f.board.acceptProposal(Actor.CLAUDE, id);
        CardChange accepted = f.board.acceptProposal(Actor.USER, id);

        assertThat(proposed.card().proposal().status()).isEqualTo(CardStatus.VERIFIED);
        assertThat(onTheBoard.proposal()).isNotNull();
        assertThat(claudeAccepts.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(accepted.card().card().status()).isEqualTo(CardStatus.VERIFIED);
        assertThat(accepted.card().card().updatedBy()).isEqualTo(Actor.USER);
        assertThat(accepted.card().proposal()).isNull();
        assertThat(f.board.activity(id, 0, 100).orElseThrow().entries()).extracting(ActivityEntry::kind)
                .contains(ActivityKind.PROPOSED, ActivityKind.PROPOSAL_ACCEPTED);
    }

    @Test
    void aProposedCloseKeepsItsResolutionAndADismissLeavesTheCard() {
        String id = card("p", "A");
        f.board.propose(Actor.CLAUDE, id, CardStatus.CLOSED, Resolution.FINE, "401 is expected before login", "");
        CardChange closed = f.board.acceptProposal(Actor.USER, id);

        String other = card("p", "B");
        f.board.propose(Actor.CLAUDE, other, CardStatus.CLOSED, Resolution.NOT_IN_FLOW, "", "");
        CardChange dismissed = f.board.dismissProposal(Actor.USER, other);

        assertThat(closed.card().card().resolution()).isEqualTo(Resolution.FINE);
        assertThat(closed.card().card().reason()).isEqualTo("401 is expected before login");
        assertThat(dismissed.card().card().status()).isEqualTo(CardStatus.INBOX);
        assertThat(dismissed.card().proposal()).isNull();
    }

    @Test
    void onlyStepsTheUserTakesCanBeProposedAndOnlyByClaude() {
        String id = card("p", "A");

        assertThat(f.board.propose(Actor.CLAUDE, id, CardStatus.VERIFIED, null, "", "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.propose(Actor.CLAUDE, id, CardStatus.TO_DO, null, "", "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.propose(Actor.CLAUDE, id, CardStatus.CLOSED, null, "", "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.propose(Actor.USER, id, CardStatus.CLOSED, Resolution.FINE, "", "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void aProposalTheCardOutgrewIsDroppedOnAccept() {
        String id = card("p", "A");
        f.board.move(Actor.USER, id, CardStatus.TO_DO);
        f.board.move(Actor.USER, id, CardStatus.FIXED);
        f.board.propose(Actor.CLAUDE, id, CardStatus.VERIFIED, null, "", "");
        f.board.move(Actor.USER, id, CardStatus.IN_PROGRESS);

        assertThat(f.board.acceptProposal(Actor.USER, id).outcome()).isEqualTo(CardChange.Outcome.CONFLICT);
        assertThat(f.board.get(id).orElseThrow().proposal()).isNull();
    }

    // -------------------------------------------------------------------------------------------------- suggested marks

    @Test
    void aSuggestedMarkWaitsGreyUntilTheUserAcceptsIt() {
        f.briefs.put(Actor.USER, "cy", "spec.md", SPEC);
        String key = f.briefs.checklist("cy").get(0).items().get(0).key();

        var suggested = f.briefs.suggest(Actor.CLAUDE, "cy", "spec.md", key, Mark.PASS, "@[call:in:c9@cy|POST /orders · 201]");
        var item = f.briefs.checklist("cy").get(0).items().get(0);
        var accepted = f.briefs.acceptSuggestion(Actor.USER, "cy", "spec.md", key);

        assertThat(suggested.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(item.mark()).isNull();
        assertThat(item.suggestion().mark()).isEqualTo(Mark.PASS);
        assertThat(accepted.item().mark().mark()).isEqualTo(Mark.PASS);
        assertThat(accepted.item().mark().actor()).isEqualTo(Actor.USER);
        assertThat(accepted.item().mark().evidence()).contains("POST /orders");
        assertThat(f.briefs.checklist("cy").get(0).items().get(0).suggestion()).isNull();
    }

    @Test
    void suggestionsAreClaudesAndOnlyTheUserAcceptsOrDismissesThem() {
        f.briefs.put(Actor.USER, "cy", "spec.md", SPEC);
        String key = f.briefs.checklist("cy").get(0).items().get(1).key();
        f.briefs.suggest(Actor.CLAUDE, "cy", "spec.md", key, Mark.FAIL, "");

        assertThat(f.briefs.suggest(Actor.USER, "cy", "spec.md", key, Mark.PASS, "").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefs.acceptSuggestion(Actor.CLAUDE, "cy", "spec.md", key).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.briefs.dismissSuggestion(Actor.USER, "cy", "spec.md", key).outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.briefs.checklist("cy").get(0).items().get(1).suggestion()).isNull();
        assertThat(f.briefs.suggest(Actor.CLAUDE, "cy", "spec.md", "nope", Mark.PASS, "").outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
    }

    // -------------------------------------------------------------------------------------------------------- fix check

    @Test
    void fixedCardsAreCheckedAgainstTheCyclesCallsToTheirEndpoint() {
        f.signatures.put("a", "5xx|POST /orders");
        f.signatures.put("b", "4xx|GET /cart");
        f.signatures.put("c", "5xx|GET /stock");
        String orders = f.create(Actor.USER, "p", "Orders 500", List.of(new MentionRef(MentionType.CALL, "in:a", "POST /orders · 500"))).card().card().id();
        String cart = f.create(Actor.USER, "p", "Cart 404", List.of(new MentionRef(MentionType.CALL, "in:b", "GET /cart · 404"))).card().card().id();
        String stock = f.create(Actor.USER, "p", "Stock 500", List.of(new MentionRef(MentionType.CALL, "in:c", "GET /stock · 500"))).card().card().id();
        for (String id : List.of(orders, cart, stock)) {
            f.board.move(Actor.USER, id, CardStatus.TO_DO);
            f.board.move(Actor.USER, id, CardStatus.FIXED);
        }
        f.cycleCalls.add(new CycleCall("in", "r1", "POST", "/orders", 201, "ok|POST /orders"));
        f.cycleCalls.add(new CycleCall("in", "r2", "GET", "/cart", 404, "4xx|GET /cart"));

        List<FixCheck> checks = f.insights.verify("p", "retest");

        assertThat(checks).extracting(FixCheck::title, FixCheck::verdict).containsExactlyInAnyOrder(
                org.assertj.core.groups.Tuple.tuple("Orders 500", FixCheck.Verdict.LOOKS_FIXED),
                org.assertj.core.groups.Tuple.tuple("Cart 404", FixCheck.Verdict.STILL_FAILING),
                org.assertj.core.groups.Tuple.tuple("Stock 500", FixCheck.Verdict.NOT_EXERCISED));
        FixCheck ordersCheck = checks.stream().filter(c -> c.title().equals("Orders 500")).findFirst().orElseThrow();
        assertThat(ordersCheck.calls()).extracting(FixCheck.Seen::ref).containsExactly("in:r1@retest");
        assertThat(ordersCheck.calls().get(0).label()).isEqualTo("POST /orders · 201");
    }
}
