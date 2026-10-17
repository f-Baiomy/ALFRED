package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase.ChangedItem;
import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase.ArrivedItem;
import com.fathy.alfred.backend.teamboards.core.application.port.in.MatchesUseCase.Match;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamTransferUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamTransferUseCase.TeamRecord;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase.Markers;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.CardInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MatchState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.fathy.alfred.backend.teamboards.core.application.service.FakeTracker.item;
import static com.fathy.alfred.backend.teamboards.core.application.service.TeamFixture.CONN;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** specs/030 US5 (the refresh result) and US6 (card matches by code) over the real store, a fake tracker and fake boards. */
class MatchServiceTest {

    @TempDir
    Path dir;
    TeamFixture f;

    @BeforeEach
    void setUp() {
        f = new TeamFixture(dir);
        f.tracker.put(item("100", "Feature", "Refunds", "Active", null, 3))
                .put(item("101", "User Story", "Refund a card payment", "Active", "100", 5))
                .put(item("102", "Bug", "Refund total is wrong", "New", "101", 2))
                .put(item("103", "Task", "Refund total report", "Closed", "101", 1))
                .put(described("105", "Bug", "Voucher page slow", "Calls to /api/vouchers/{id} take seconds", "101", 1));
        f.withToken();
        f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
    }

    @AfterEach
    void tearDown() {
        f.close();
    }

    static Item described(String id, String type, String title, String description, String parent, int rev) {
        Item i = item(id, type, title, "Active", parent, rev);
        Map<String, String> fields = new LinkedHashMap<>(i.fields());
        fields.put("System.Description", description);
        return new Item(i.extId(), i.type(), false, i.title(), i.state(), i.assignee(), i.squad(), i.sprint(), i.area(), i.url(), i.rev(),
                i.changedAt(), i.changedBy(), fields, i.links(), i.nativeJson(), i.identities(), i.project());
    }

    static Item moved(Item i, String state, String sprint, int rev) {
        Map<String, String> fields = new LinkedHashMap<>(i.fields());
        fields.put("System.State", state);
        fields.put("System.IterationPath", sprint);
        return new Item(i.extId(), i.type(), false, i.title(), state, i.assignee(), i.squad(), sprint, i.area(), i.url(), rev, i.changedAt(),
                i.changedBy(), fields, i.links(), i.nativeJson(), i.identities(), i.project());
    }

    // ---------------------------------------------------------------------------------------------- refresh result

    @Test
    void theRefreshNamesNewItemsChangedItemsWithNewCommentsAndTheMainsMove() {
        f.tracker.put(moved(item("101", "User Story", "Refund a card payment", "Active", "100", 5), "Removed", "Sprint 2", 7));
        f.tracker.put(item("104", "Bug", "Refund email missing", "New", "101", 1));
        f.tracker.comments.put("101", List.of(new Comment("9", "Omar", Instant.now(), "Dropped from the release")));

        var r = f.boardItems.sync("b1", true);

        assertThat(r.newItems()).extracting(ArrivedItem::item).containsExactly("104");
        assertThat(r.changedItems()).singleElement().satisfies(c -> {
            assertThat(c.item()).isEqualTo("101");
            assertThat(c.newComments()).isEqualTo(1);
            assertThat(c.fields()).contains("comments");
        });
        assertThat(r.mainState()).isNotNull();
        assertThat(r.mainState().fromState()).isEqualTo("Active");
        assertThat(r.mainState().toState()).isEqualTo("Removed");
        assertThat(r.mainState().category()).isEqualTo("Removed");
        assertThat(r.mainState().closed()).isTrue();
        assertThat(r.mainState().fromIteration()).isEqualTo("Sprint 1");
        assertThat(r.mainState().toIteration()).isEqualTo("Sprint 2");
        // new items still wait in Incoming
        assertThat(f.incoming.list("b1", false)).extracting(row -> row.item()).contains("104");
    }

    @Test
    void aMainMovedOnlyOutOfItsIterationIsReportedAndAnUnmovedMainIsNot() {
        assertThat(f.boardItems.sync("b1", true).mainState()).isNull();
        f.tracker.put(moved(item("101", "User Story", "Refund a card payment", "Active", "100", 5), "Active", "Sprint 3", 6));
        var r = f.boardItems.sync("b1", true);
        assertThat(r.mainState().toIteration()).isEqualTo("Sprint 3");
        assertThat(r.mainState().closed()).isFalse();
        assertThat(r.changedItems()).extracting(ChangedItem::item).containsExactly("101");
    }

    // ---------------------------------------------------------------------------------------------------- matches

    @Test
    void anUnlinkedCardGetsTheOpenBugOrTaskSharingItsWordsButNotAClosedOneOrTheMain() {
        CardInfo card = f.boards.card("b1", "Refund total wrong");
        var r = f.boardItems.sync("b1", true);
        assertThat(r.matches()).isEqualTo(1);
        List<Match> m = f.matches.matches(card.id());
        assertThat(m).singleElement().satisfies(x -> {
            assertThat(x.row().item()).isEqualTo("102");
            assertThat(x.title()).isEqualTo("Refund total is wrong");
            assertThat(x.row().why()).contains("refund", "total", "wrong");
            assertThat(x.row().score()).isGreaterThanOrEqualTo(MatchService.PROPOSE_AT);
        });
    }

    @Test
    void anEndpointPathTheCardNamesMatchesEvenWithFewWords() {
        CardInfo card = f.boards.card("b1", "Slow");
        f.boards.appendToDescription(card.id(), "GET /api/vouchers/7731 took 9 s");
        f.boardItems.sync("b1", true);
        assertThat(f.matches.matches(card.id())).extracting(x -> x.row().item()).containsExactly("105");
        assertThat(f.matches.matches(card.id()).get(0).row().why()).contains("same endpoint /api/vouchers/{id}");
    }

    @Test
    void anItemMadeBeforeTheCardIsNotProposed() {
        Item old = described("102", "Bug", "Refund total is wrong", "About Refund total is wrong", "101", 3);
        Map<String, String> fields = new LinkedHashMap<>(old.fields());
        fields.put("System.CreatedDate", "2020-01-01T00:00:00Z");
        f.tracker.put(new Item(old.extId(), old.type(), false, old.title(), "New", old.assignee(), old.squad(), old.sprint(), old.area(), old.url(),
                old.rev(), old.changedAt(), old.changedBy(), fields, old.links(), old.nativeJson(), old.identities(), old.project()));
        CardInfo card = f.boards.card("b1", "Refund total wrong");
        assertThat(f.boardItems.sync("b1", true).matches()).isZero();
        assertThat(f.matches.matches(card.id())).isEmpty();
    }

    @Test
    void aCardThatLinksAnItemGetsNoMatches() {
        CardInfo card = f.boards.card("b1", "Refund total wrong");
        f.cardItems.link(Who.USER, card.id(), CONN, "105", Markers.NONE, null);
        f.boardItems.sync("b1", true);
        assertThat(f.matches.matches(card.id())).isEmpty();
    }

    @Test
    void notThisOneIsKeptAndNeverProposedAgain() {
        CardInfo card = f.boards.card("b1", "Refund total wrong");
        f.boardItems.sync("b1", true);
        assertThat(f.matches.reject(Who.USER, card.id(), CONN, "102")).isEmpty();
        assertThat(f.boardItems.sync("b1", true).matches()).isZero();
        assertThat(f.matches.propose("b1")).isZero();
        assertThat(f.cache.match(card.id(), CONN, "102")).get().extracting(x -> x.state()).isEqualTo(MatchState.REJECTED);
    }

    @Test
    void linkingAMatchLinksTheCardAndTakesTheItemOutOfOtherCardsProposals() {
        CardInfo one = f.boards.card("b1", "Refund total wrong");
        CardInfo two = f.boards.card("b1", "Wrong refund total shown");
        f.boardItems.sync("b1", true);
        assertThat(f.matches.matches(two.id())).extracting(x -> x.row().item()).contains("102");

        var items = f.matches.link(Who.USER, one.id(), CONN, "102");

        assertThat(items).extracting(i -> i.item()).containsExactly("102");
        assertThat(f.cache.cardLinks(one.id())).extracting(l -> l.item()).containsExactly("102");
        assertThat(f.cache.match(one.id(), CONN, "102")).get().extracting(x -> x.state()).isEqualTo(MatchState.LINKED);
        assertThat(f.matches.matches(two.id())).extracting(x -> x.row().item()).doesNotContain("102");
        f.boardItems.sync("b1", true);
        assertThat(f.matches.matches(two.id())).extracting(x -> x.row().item()).doesNotContain("102");
    }

    @Test
    void claudeOnlyWritesItsReasonAndTheReasonSurvivesTheNextRefresh() {
        CardInfo card = f.boards.card("b1", "Refund total wrong");
        f.boardItems.sync("b1", true);
        assertThatThrownBy(() -> f.matches.link(Who.CLAUDE, card.id(), CONN, "102")).isInstanceOf(TeamException.class)
                .extracting(e -> ((TeamException) e).code()).isEqualTo(Code.USER_ONLY);
        assertThatThrownBy(() -> f.matches.reject(Who.CLAUDE, card.id(), CONN, "102")).isInstanceOf(TeamException.class);
        f.matches.why(card.id(), CONN, "102", "Same total, same screen: the bug's repro is this card's call");
        f.tracker.put(item("102", "Bug", "Refund total is wrong again", "New", "101", 3));
        f.boardItems.sync("b1", true);
        assertThat(f.matches.matches(card.id()).get(0).row().why()).startsWith("Same total, same screen");
    }

    @Test
    void aRejectedMatchTravelsInTheBoardExportAndProposalsDoNot(@TempDir Path other) {
        CardInfo one = f.boards.card("b1", "Refund total wrong");
        CardInfo two = f.boards.card("b1", "Wrong refund total shown");
        f.boardItems.sync("b1", true);
        f.matches.reject(Who.USER, one.id(), CONN, "102");
        List<TeamRecord> out = f.transfer.export("b1");
        assertThat(out).filteredOn(r -> r.kind().equals(TeamTransferUseCase.CARD_MATCH)).singleElement()
                .satisfies(r -> assertThat(r.fields()).containsEntry("cardId", one.id()).containsEntry("state", "REJECTED"));
        assertThat(out).filteredOn(r -> r.kind().equals(TeamTransferUseCase.CARD_MATCH)).noneMatch(r -> two.id().equals(r.fields().get("cardId")));

        TeamFixture g = new TeamFixture(other);
        try {
            TeamRecord rec = out.stream().filter(r -> r.kind().equals(TeamTransferUseCase.CARD_MATCH)).findFirst().orElseThrow();
            assertThat(g.transfer.importRecord(rec.kind(), "b2", "card-9", rec.fields())).isTrue();
            assertThat(g.cache.match("card-9", CONN, "102")).get().satisfies(x -> {
                assertThat(x.state()).isEqualTo(MatchState.REJECTED);
                assertThat(x.boardId()).isEqualTo("b2");
            });
        } finally {
            g.close();
        }
    }

    // ------------------------------------------------------------------------------------------------------ score

    @Test
    void scoringIgnoresStopWordsTagsAndNumbersAndNormalisesPaths() {
        var t = MatchService.text("<p>The refund for order 12345 failed</p> see /api/orders/12/refunds/ and /api/orders/{orderId}/refunds");
        assertThat(t.words()).contains("refund", "order", "failed").doesNotContain("the", "for", "12345", "p");
        assertThat(t.paths()).containsExactly("/api/orders/{id}/refunds");
        assertThat(MatchService.score(MatchService.text("Login button"), MatchService.text("Refund total is wrong"))).isNull();
    }
}
