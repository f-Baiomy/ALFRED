package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase.NewBundle;
import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase.Markers;
import com.fathy.alfred.backend.teamboards.core.application.port.in.HookUseCase.Ping;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.Part;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.CardInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SearchResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.fathy.alfred.backend.teamboards.core.application.service.FakeTracker.item;
import static com.fathy.alfred.backend.teamboards.core.application.service.TeamFixture.CONN;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** specs/028 US1-US6 over the real store, a fake tracker and fake boards. */
class TeamServicesTest {

    @TempDir
    Path dir;
    TeamFixture f;

    @BeforeEach
    void setUp() {
        f = new TeamFixture(dir);
        f.tracker.put(item("100", "Feature", "Refunds", "Active", null, 3))
                .put(item("101", "User Story", "Refund a card payment", "Active", "100", 5))
                .put(item("102", "Bug", "Refund total is wrong", "New", "101", 2))
                .put(item("103", "Task", "Old task", "Closed", "101", 1))
                .put(item("200", "Bug", "Voucher crash", "Active", null, 1));
    }

    @AfterEach
    void tearDown() {
        f.close();
    }

    static SearchIn text(String t) {
        return new SearchIn(t, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, 50);
    }

    // ------------------------------------------------------------------------------------------------------- token

    @Test
    void noTokenNoSearch() {
        assertThatThrownBy(() -> f.search.search(CONN, text("refund"))).isInstanceOf(TeamException.class)
                .extracting(e -> ((TeamException) e).code()).isEqualTo(Code.TOKEN_MISSING);
    }

    @Test
    void puttingTheTokenNamesItsOwnerAndARefusedTokenIsDropped() {
        var status = f.team.putToken(CONN, new Token(f.tracker.goodToken));
        assertThat(status.live()).isTrue();
        assertThat(status.owner().name()).isEqualTo("Sara Ali");
        assertThat(f.team.me(CONN)).get().extracting(m -> m.source()).isEqualTo("TOKEN_OWNER");
        assertThatThrownBy(() -> f.team.putToken(CONN, new Token("wrong"))).isInstanceOf(TeamException.class);
        assertThat(f.vault.token(CONN)).get().extracting(Token::value).isEqualTo(f.tracker.goodToken);
        f.tracker.goodToken = "rotated";
        assertThatThrownBy(() -> f.search.search(CONN, text("x"))).extracting(e -> ((TeamException) e).code()).isEqualTo(Code.TOKEN_REJECTED);
        assertThat(f.vault.token(CONN)).isEmpty();
    }

    @Test
    void theTokenIsNeverWrittenToTheDatabase() throws Exception {
        f.tracker.goodToken = "pat-very-secret-0987654321";
        var status = f.team.putToken(CONN, new Token(f.tracker.goodToken));
        // no answer echoes it: the token status, a search, a bundle, the vault's own text
        assertThat(String.valueOf(status)).doesNotContain("pat-very-secret");
        assertThat(String.valueOf(f.search.search(CONN, text("refund")))).doesNotContain("pat-very-secret");
        assertThat(String.valueOf(f.vault)).doesNotContain("pat-very-secret");
        assertThat(String.valueOf(new Token(f.tracker.goodToken))).doesNotContain("pat-very-secret");
        f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "x", List.of(
                new WriteStep(StepKind.COMMENT, Map.of("text", "hi"), true, false, null)), null, null));
        assertThat(String.valueOf(f.writes.approve(Who.USER, b.id()))).doesNotContain("pat-very-secret");
        f.close();
        for (java.nio.file.Path p : java.nio.file.Files.list(dir).toList()) {
            String bytes = new String(java.nio.file.Files.readAllBytes(p), java.nio.charset.StandardCharsets.ISO_8859_1);
            assertThat(bytes).as(p.toString()).doesNotContain("pat-very-secret");
        }
        f = new TeamFixture(dir);
    }

    @Test
    void thisIsMeHoldsUntilTheTokenChangesHands() {
        f.withToken();
        f.team.putMe(CONN, "p-2");
        assertThat(f.team.me(CONN)).get().extracting(m -> m.person().extId()).isEqualTo("p-2");
        f.tracker.owner = new com.fathy.alfred.backend.teamboards.spi.model.Person("p-9", "Other", "o@example.com");
        f.team.putToken(CONN, new Token(f.tracker.goodToken));
        assertThat(f.team.me(CONN)).get().extracting(m -> m.person().extId()).isEqualTo("p-9");
    }

    // ------------------------------------------------------------------------------------------------------ search

    @Test
    void searchIsLiveOpenOnlyByDefaultAndStoresNothing() {
        f.withToken();
        SearchResult r = f.search.search(CONN, text("refund"));
        assertThat(r.items()).extracting(x -> x.id()).containsExactly("100", "101", "102");
        assertThat(f.tracker.searches.get(0).openOnly()).isTrue();
        assertThat(r.pageSize()).isEqualTo(50);
        assertThat(f.cache.boardsWithItems()).isEmpty();
        assertThat(f.cache.copy(CONN, "101")).isEmpty();
        assertThatThrownBy(() -> f.search.search(CONN, new SearchIn(null, null, null, null, null, null, null, null, null, null, null, null, null, null,
                0, 51))).isInstanceOf(TeamException.class);
    }

    @Test
    void aQueryMustBeASelect() {
        f.withToken();
        assertThatThrownBy(() -> f.search.query(CONN, "DELETE FROM WorkItems", 10)).isInstanceOf(TeamException.class);
    }

    @Test
    void rowsCarryTheirBoardsAndChangedSinceTheCopy() {
        f.withToken();
        f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
        f.tracker.put(item("101", "User Story", "Refund a card payment", "Resolved", "100", 6));
        SearchResult r = f.search.search(CONN, text("card payment"));
        assertThat(r.items().get(0).boards()).singleElement().satisfies(b -> {
            assertThat(b.boardId()).isEqualTo("b1");
            assertThat(b.role()).isEqualTo("MAIN");
            assertThat(b.changed()).isTrue();
        });
    }

    // -------------------------------------------------------------------------------------------- main and tree

    @Test
    void theFirstItemIsTheMainWithItsWholeTreeAsReferences() {
        f.withToken();
        BoardItemsUseCase.View v = f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
        assertThat(v.main().row().item()).isEqualTo("101");
        assertThat(v.main().hasCopy()).isTrue();
        assertThat(v.items()).extracting(i -> i.row().item() + ":" + i.row().relation()).containsExactlyInAnyOrder("100:ANCESTOR", "102:DESCENDANT",
                "103:DESCENDANT");
        assertThat(v.items()).allMatch(i -> !i.hasCopy());
        assertThat(f.cache.copy(CONN, "102")).isEmpty();
    }

    @Test
    void reRootingMovesTheMainAndDropsTheOldCopy() {
        f.withToken();
        f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
        BoardItemsUseCase.MainChange m = f.boardItems.setMain(Who.USER, "b1", CONN, "100", 0);
        assertThat(m.reseedOffer()).isTrue();
        assertThat(f.cache.main("b1")).get().extracting(BoardItemRow::item).isEqualTo("100");
        assertThat(f.cache.boardItems("b1").stream().filter(r -> r.role().equals("MAIN")).count()).isEqualTo(1);
        assertThat(f.cache.copy(CONN, "101")).isEmpty();
        assertThat(f.cache.copy(CONN, "100")).isPresent();
        assertThatThrownBy(() -> f.boardItems.setMain(Who.CLAUDE, "b1", CONN, "101", 0)).isInstanceOf(TeamException.class);
    }

    @Test
    void aBigTreeAsksFirst() {
        f.withToken();
        for (int i = 0; i < 205; i++) {
            f.tracker.put(item(String.valueOf(1000 + i), "Task", "t" + i, "Active", "100", 1));
        }
        assertThatThrownBy(() -> f.boardItems.add(Who.USER, "b1", CONN, "100", false, 0, null)).extracting(e -> ((TeamException) e).code())
                .isEqualTo(Code.ASK);
        BoardItemsUseCase.View v = f.boardItems.add(Who.USER, "b1", CONN, "100", false, 1000, null);
        assertThat(v.items()).hasSizeGreaterThan(200);
    }

    @Test
    void claudeLinksOnlyThroughABundleUnlessTheUserAsked() {
        f.withToken();
        assertThatThrownBy(() -> f.boardItems.add(Who.CLAUDE, "b1", CONN, "101", true, 0, null)).extracting(e -> ((TeamException) e).code())
                .isEqualTo(Code.CONFLICT);
        assertThat(f.cache.boardItems("b1")).isEmpty();
        assertThat(f.writes.list("b1", null, "WAITING", 10)).singleElement().satisfies(b -> assertThat(b.steps().get(0).kind()).isEqualTo(StepKind.LINK_ALFRED));
        f.boardItems.add(Who.CLAUDE, "b1", CONN, "https://dev.azure.com/o/p/_workitems/edit/101", true, 0, "msg-7");
        assertThat(f.cache.main("b1")).get().extracting(BoardItemRow::item).isEqualTo("101");
    }

    @Test
    void syncDiffsFieldByFieldKeepsTheCopyUntilKeptAndOffersNewChildren() {
        f.withToken();
        f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
        f.tracker.put(item("101", "User Story", "Refund a card payment, partly", "Active", "100", 6));
        f.tracker.put(item("104", "Bug", "Refund email missing", "New", "101", 1));
        f.tracker.comments.put("101", List.of(new Comment("1", "Omar", Instant.now(), "Please check partial refunds")));
        var r = f.boardItems.sync("b1", true);
        assertThat(r.changed()).isEqualTo(1);
        assertThat(r.newInTree()).isEqualTo(1);
        var syncs = f.boardItems.syncs(CONN, "101", 10);
        assertThat(syncs.get(0).diff()).extracting(d -> d.field()).contains("System.Title", "comments");
        assertThat(f.cache.copy(CONN, "101")).get().extracting(c -> c.rev()).isEqualTo(5);
        assertThat(f.incoming.list("b1", false)).extracting(IncomingRow::item).containsExactly("104");
        f.boardItems.keep("b1", CONN, "101");
        assertThat(f.cache.copy(CONN, "101")).get().extracting(c -> c.rev()).isEqualTo(6);
        assertThat(f.boardItems.sync("b1", false).skipped()).isTrue();
    }

    // ------------------------------------------------------------------------------------------------ cards

    @Test
    void aUserLinkLivesInAlfredAtOnceButMarkersWaitForApproval() {
        f.withToken();
        CardInfo card = f.boards.card("b1", "Refund total");
        var r = f.cardItems.link(Who.USER, card.id(), CONN, "102", Markers.ALL, null);
        assertThat(r.items()).singleElement().extracting(i -> i.item()).isEqualTo("102");
        assertThat(f.cache.copy(CONN, "102")).isPresent();
        assertThat(f.boards.cards.get(card.id()).description()).contains("@[workitem:c1/102|Bug 102 Refund total is wrong]");
        assertThat(f.cache.boardItem("b1", CONN, "102")).get().extracting(BoardItemRow::role).isEqualTo("CARD");
        assertThat(r.bundle().state()).isEqualTo(WriteState.WAITING);
        assertThat(f.tracker.writes).isEmpty();
        f.writes.approve(Who.USER, r.bundle().id());
        assertThat(f.tracker.writes).anyMatch(w -> w.startsWith("comment 102")).anyMatch(w -> w.equals("tag 102 alfred"));
        assertThat(f.cache.cardLinks(card.id()).get(0).tag()).isTrue();
    }

    @Test
    void claudeNeverApprovesAndNothingIsWrittenBeforeTheUserDoes() {
        f.withToken();
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Tell Azure", List.of(
                new WriteStep(StepKind.STATE, Map.of("state", "Resolved"), true, false, null),
                new WriteStep(StepKind.COMMENT, Map.of("text", "Fixed"), false, false, null)), null, null));
        assertThatThrownBy(() -> f.writes.approve(Who.CLAUDE, b.id())).isInstanceOf(TeamException.class);
        assertThat(f.tracker.writes).isEmpty();
        WriteBundle sent = f.writes.approve(Who.USER, b.id());
        assertThat(sent.state()).isEqualTo(WriteState.SENDING);
        assertThat(f.tracker.writes).containsExactly("state 102 Resolved"); // the unticked comment stays unsent
        assertThat(f.writes.get(b.id())).get().extracting(WriteBundle::state).isEqualTo(WriteState.DONE);
    }

    @Test
    void anAttachStepNeedsItsFileAndCommentsEndWithTheFooter() {
        f.withToken();
        f.hook.putPublicAddress(CONN, "https://alfred.example.com/");
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Evidence", List.of(
                new WriteStep(StepKind.COMMENT, Map.of("text", "Found it"), true, false, null),
                new WriteStep(StepKind.ATTACH, Map.of("name", "calls.html"), true, true, null)), null, null));
        assertThat(b.steps().get(1).unmasked()).isFalse(); // Claude never sends a file unmasked
        assertThatThrownBy(() -> f.writes.approve(Who.USER, b.id())).isInstanceOf(TeamException.class);
        f.writes.putFile(Who.USER, b.id(), 1, "calls.html", "<html>".getBytes());
        f.writes.approve(Who.USER, b.id());
        assertThat(f.tracker.writes.get(0)).contains("Found it").contains("via Alfred: board Board b1").contains("https://alfred.example.com/board?board=b1");
        assertThat(f.tracker.writes.get(1)).isEqualTo("attach 102 calls.html 6");
        assertThat(f.cache.bundleFile(b.id(), 1)).isEmpty();
    }

    @Test
    void creatingInAzureFromACardLinksTheNewItem() {
        f.withToken();
        CardInfo card = f.boards.card("b1", "Receipt missing");
        WriteBundle b = f.cardItems.create(Who.CLAUDE, card.id(), CONN, new com.fathy.alfred.backend.teamboards.spi.model.NewItem(null, "Bug",
                "Receipt missing", null, null, null, null), Markers.NONE);
        f.writes.approve(Who.USER, b.id());
        assertThat(f.cache.cardLinks(card.id())).singleElement().extracting(l -> l.item()).isEqualTo("900");
    }

    @Test
    void verifiedPreparesATellAzureBundleThatWaits() {
        f.withToken();
        CardInfo card = f.boards.card("b1", "Refund total");
        f.cardItems.link(Who.USER, card.id(), CONN, "102", Markers.NONE, null);
        f.writes.cardStatusChanged(card.id(), "b1", "FIXED", "VERIFIED", null, Who.USER);
        List<WriteBundle> waiting = f.writes.list(null, card.id(), "WAITING", 10);
        assertThat(waiting).singleElement().satisfies(b -> {
            assertThat(b.steps()).extracting(WriteStep::kind).containsExactly(StepKind.STATE, StepKind.COMMENT, StepKind.ATTACH);
            assertThat(b.steps().get(0).payload().get("state")).isEqualTo("Resolved");
        });
        assertThat(f.tracker.writes).isEmpty();
    }

    // ---------------------------------------------------------------------------------------------- incoming

    @Test
    void incomingWaitsWithItsMatchAndIgnoreHoldsUntilANewRev() {
        f.withToken();
        CardInfo same = f.boards.card("b1", "Voucher crash");
        IncomingRow r = f.incoming.add(Who.USER, "b1", CONN, "200");
        assertThat(r.state()).isEqualTo(IncomingState.WAITING);
        assertThat(r.matchCard()).isEqualTo(same.id());
        assertThat(f.incoming.arrive("b1", CONN, f.tracker.items.get("200"), IncomingSource.RULE)).isFalse();
        f.incoming.ignore(Who.USER, "b1", CONN, "200");
        assertThat(f.incoming.arrive("b1", CONN, f.tracker.items.get("200"), IncomingSource.RULE)).isFalse();
        assertThat(f.incoming.arrive("b1", CONN, item("200", "Bug", "Voucher crash", "Active", null, 2), IncomingSource.RULE)).isTrue();
    }

    @Test
    void claudeProposesTheUserMakesTheCardAndFeaturesStayInRelatedItems() {
        f.withToken();
        f.incoming.add(Who.CLAUDE, "b1", CONN, "200");
        f.incoming.propose(Who.CLAUDE, "b1", CONN, "200", "NEW", null, "A new crash on vouchers");
        assertThatThrownBy(() -> f.incoming.card(Who.CLAUDE, "b1", CONN, "200", false)).isInstanceOf(TeamException.class);
        String id = f.incoming.card(Who.USER, "b1", CONN, "200", false);
        assertThat(f.boards.cards.get(id).kind()).isEqualTo("BUG");
        assertThat(f.incoming.list("b1", false)).isEmpty();
        f.incoming.add(Who.USER, "b1", CONN, "100");
        assertThatThrownBy(() -> f.incoming.card(Who.USER, "b1", CONN, "100", false)).hasMessageContaining("Related items");
    }

    // ------------------------------------------------------------------------------------------- hook and rules

    @Test
    void theHookChecksItsSecretAndKeepsIdsUntilATokenIsThere() {
        String secret = f.hook.rotateSecret(CONN);
        assertThat(f.cache.hook(CONN).get().secretHash()).doesNotContain(secret);
        assertThat(f.hook.ping("fake", "bad", "{}")).isEqualTo(Ping.BAD_SECRET);
        assertThat(f.cache.hook(CONN).get().badPings()).isEqualTo(1);
        assertThat(f.hook.ping("fake", secret, "{\"eventType\":\"workitem.updated\",\"resource\":{\"workItemId\":102}}")).isEqualTo(Ping.ACCEPTED);
        assertThat(f.cache.waiting(CONN)).containsExactly("102");
        assertThat(f.hook.info(CONN).lastEvent()).isEqualTo("workitem.updated");
        f.withToken();
        f.hook.route(CONN);
        assertThat(f.cache.waiting(CONN)).isEmpty();
    }

    @Test
    void aWatchRuleBringsNewMatchesOnce() {
        f.withToken();
        f.rules.put("b1", null, CONN, "Refund bugs", text("refund"));
        assertThat(f.rules.run("b1", "REFRESH")).isEqualTo(3);
        assertThat(f.rules.run("b1", "REFRESH")).isZero();
        assertThat(f.rules.rules("b1").get(0).lastNew()).isZero();
    }

    // ---------------------------------------------------------------------------------------------- start, seed

    @Test
    void setupLinkMakesTheStartedItemTheMainAndTheSeedReadsItsCopy() {
        f.withToken();
        var started = f.starts.start(CONN, "101", new com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.Target("odeysys",
                "b1", false));
        assertThat(started.outcome().name()).isEqualTo("WAITING");
        assertThat(f.boards.chat.get(0)).startsWith("/alfred-setup c1/101");
        f.starts.link("b1", CONN, "101");
        assertThat(f.cache.main("b1")).get().extracting(BoardItemRow::item).isEqualTo("101");
        f.vault.forget(CONN);
        var seed = f.seeds.seed(CONN, "101").orElseThrow();
        assertThat(seed.purpose()).isEqualTo("About Refund a card payment");
        assertThat(seed.children()).anyMatch(c -> c.startsWith("102 · Bug"));
        assertThat(seed.board()).isEqualTo("b1");
    }

    @Test
    void itemViewShowsTheDiffAgainstTheCopy() {
        f.withToken();
        f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
        f.tracker.put(item("101", "User Story", "Refund a card payment", "Resolved", "100", 6));
        var view = f.search.item(CONN, "101", Set.of(Part.COMMENTS));
        assertThat(view.copyRev()).isEqualTo(5);
        assertThat(view.diff()).extracting(d -> d.field()).contains("System.State");
        assertThat(view.item().nativeJson()).isNull();
    }

    /** specs/028 FR-112: a board's tracker side goes into its export and comes back on another Alfred, copies whole. */
    @Test
    void aBoardsTrackerSideTravelsInItsExportAndComesBack(@TempDir Path other) {
        f.withToken();
        f.boardItems.add(Who.USER, "b1", CONN, "101", false, 0, null);
        CardInfo card = f.boards.card("b1", "Refund total");
        f.cardItems.link(Who.USER, card.id(), CONN, "102", Markers.NONE, null);
        var exported = f.transfer.export("b1");
        assertThat(exported).extracting(r -> r.kind()).contains("team-item", "team-card-link");
        assertThat(exported.stream().filter(r -> "101".equals(r.fields().get("item"))).findFirst().orElseThrow().fields()).containsKey("copy");

        TeamFixture there = new TeamFixture(other);
        try {
            for (var r : exported) {
                there.transfer.importRecord(r.kind(), "b2", "team-card-link".equals(r.kind()) ? "card-new" : null, r.fields());
            }
            assertThat(there.cache.main("b2")).get().extracting(BoardItemRow::item).isEqualTo("101");
            assertThat(there.cache.copy(CONN, "101")).isPresent();
            assertThat(there.cache.copy(CONN, "102")).isPresent();
            assertThat(there.cache.cardLinks("card-new")).singleElement().extracting(l -> l.item()).isEqualTo("102");
            // a record naming a connection this Alfred does not have is skipped
            assertThat(there.transfer.importRecord("team-item", "b2", null, Map.of("conn", "elsewhere", "item", "5"))).isFalse();
        } finally {
            there.close();
        }
    }

    /** specs/028 T073: syncs keep the newest 50 per item; nothing waiting or recent is trimmed. */
    @Test
    void retentionKeepsTheNewestFiftySyncsPerItem() {
        Instant now = Instant.parse("2026-10-17T10:00:00Z");
        for (int i = 0; i < 60; i++) {
            f.cache.addSync(CONN, "101", i, i + 1, now.minusSeconds(60L * (60 - i)), List.of());
        }
        f.cache.addSync(CONN, "102", 1, 2, now, List.of());
        f.cache.trim(now);
        assertThat(f.cache.syncs(CONN, "101", 100)).hasSize(50).first().extracting(r -> r.toRev()).isEqualTo(60);
        assertThat(f.cache.syncs(CONN, "102", 100)).hasSize(1);
    }
}
