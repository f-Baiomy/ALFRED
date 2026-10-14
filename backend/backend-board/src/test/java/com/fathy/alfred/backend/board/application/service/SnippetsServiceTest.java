package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.NewPage;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.PageEdit;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.Snippet;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Pages, versions, saved state and shots (specs/017 R16, R23, R28-R32). */
class SnippetsServiceTest {

    /** The smallest PNG: the signature is all the service checks. */
    private static final String PNG = "data:image/png;base64," + Base64.getEncoder().encodeToString(
            new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 0});

    @TempDir
    Path dir;

    private BoardFixture f;
    private CardDetail card;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        card = f.add(Actor.USER, "odeysys", CardKind.BUG, "Fare drifts", "");
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private Snippet page(Actor actor, String owner, String name, String source) {
        var r = f.snippets.create(actor, new NewPage(owner, "odeysys", name, "html", "live", source));
        assertThat(r.outcome()).as(r.message()).isEqualTo(Outcome.OK);
        return r.value();
    }

    @Test
    void aPageBelongsToItsCardCycleOrProjectAndListsInTabOrderWithoutItsSource() {
        Snippet a = page(Actor.USER, "card:" + card.card().id(), "Dashboard", "<b>a</b>");
        Snippet b = page(Actor.CLAUDE, "card:" + card.card().id(), "Timeline", "<b>b</b>");
        page(Actor.USER, "cycle:c-1", "Cycle page", "x");
        page(Actor.USER, "project:odeysys", "Project page", "x");

        var list = f.snippets.pages("card:" + card.card().id(), null).value();
        assertThat(list).extracting(Snippet::name).containsExactly("Dashboard", "Timeline");
        assertThat(list).allMatch(s -> s.source() == null);
        assertThat(a.project()).isEqualTo("odeysys");
        assertThat(a.cardId()).isEqualTo(card.card().id());
        assertThat(b.position()).isEqualTo(a.position() + 1);
        assertThat(f.snippets.pages("cycle:c-1", "odeysys").value()).extracting(Snippet::cycleId).containsExactly("c-1");
        assertThat(f.snippets.pages("project:odeysys", null).value()).hasSize(1);
        assertThat(f.snippets.page(a.id(), null).orElseThrow().source()).isEqualTo("<b>a</b>");
        assertThat(f.signals).contains("pages:odeysys:null");
    }

    @Test
    void aPageNeedsARealOwnerANameAndAtMost256Kb() {
        assertThat(f.snippets.create(Actor.USER, new NewPage("card:nope", null, "x", "html", "", "")).outcome()).isEqualTo(Outcome.NOT_FOUND);
        assertThat(f.snippets.create(Actor.USER, new NewPage("table:x", null, "x", "html", "", "")).outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.snippets.create(Actor.USER, new NewPage("cycle:c-1", null, "x", "html", "", "")).message()).contains("project");
        assertThat(f.snippets.create(Actor.USER, new NewPage("project:p", null, " ", "html", "", "")).message()).contains("name");
        assertThat(f.snippets.create(Actor.USER, new NewPage("project:p", null, "x", "flash", "", "")).outcome()).isEqualTo(Outcome.INVALID);
        var big = f.snippets.create(Actor.USER, new NewPage("project:p", null, "x", "html", "", "é".repeat(128 * 1024 + 1)));
        assertThat(big.message()).contains("256 KB");
        assertThat(f.snippets.create(Actor.USER, new NewPage("project:p", null, "x", "html", "", "é".repeat(128 * 1024))).outcome())
                .isEqualTo(Outcome.OK);
    }

    @Test
    void everySaveIsAVersionAndAnOldOneCanBeReadBack() {
        Snippet s = page(Actor.USER, "card:" + card.card().id(), "Dash", "v1");
        var v2 = f.snippets.update(Actor.USER, s.id(), new PageEdit(null, null, "v2", null, null, 1));
        assertThat(v2.value().version()).isEqualTo(2);
        var pin = f.snippets.update(Actor.USER, s.id(), new PageEdit(null, null, null, true, null, null));
        assertThat(pin.value().version()).as("pinning is not a new version").isEqualTo(2);
        assertThat(pin.value().pinned()).isTrue();

        assertThat(f.snippets.versions(s.id()).value()).extracting(v -> v.version() + ":" + v.size()).containsExactly("2:2", "1:2");
        assertThat(f.snippets.page(s.id(), 1).orElseThrow().source()).isEqualTo("v1");
        assertThat(f.snippets.page(s.id(), 2).orElseThrow().source()).isEqualTo("v2");
        assertThat(f.snippets.page(s.id(), 9)).isEmpty();
    }

    @Test
    void savingOverANewerVersionIsAConflict() {
        Snippet s = page(Actor.USER, "project:odeysys", "Dash", "v1");
        f.snippets.update(Actor.USER, s.id(), new PageEdit(null, null, "v2", null, null, 1));
        var stale = f.snippets.update(Actor.USER, s.id(), new PageEdit(null, null, "mine", null, null, 1));
        assertThat(stale.outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.snippets.page(s.id(), null).orElseThrow().source()).isEqualTo("v2");
    }

    @Test
    void claudeChangesAndDeletesOnlyThePagesItCreated() {
        Snippet mine = page(Actor.USER, "card:" + card.card().id(), "Mine", "x");
        Snippet its = page(Actor.CLAUDE, "card:" + card.card().id(), "Claude's", "x");
        assertThat(f.snippets.update(Actor.CLAUDE, mine.id(), new PageEdit(null, null, "y", null, null, null)).outcome())
                .isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.snippets.delete(Actor.CLAUDE, mine.id()).outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.snippets.update(Actor.CLAUDE, its.id(), new PageEdit(null, null, "y", null, null, null)).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.update(Actor.USER, its.id(), new PageEdit("Renamed", null, null, null, null, null)).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.delete(Actor.CLAUDE, its.id()).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.delete(Actor.USER, mine.id()).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.pages("card:" + card.card().id(), null).value()).isEmpty();
    }

    @Test
    void stateIsJsonKeptPerSnippetWithItsHistoryAndSignalled() {
        Snippet s = page(Actor.USER, "card:" + card.card().id(), "Dash", "x");
        assertThat(f.snippets.putState(Actor.USER, s.id(), "filter", "{\"status\":500}").outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.putState(Actor.USER, s.id(), "filter", "{\"status\":200}").outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.state(s.id(), "filter").value().value()).isEqualTo("{\"status\":200}");
        assertThat(f.snippets.stateHistory(s.id(), "filter").value()).extracting(v -> v.value()).containsExactly("{\"status\":500}");
        assertThat(f.signals).contains("state:" + s.id() + ":odeysys:null");

        assertThat(f.snippets.putState(Actor.USER, s.id(), "bad", "{not json").message()).contains("JSON");
        assertThat(f.snippets.putState(Actor.USER, s.id(), "k".repeat(101), "1").outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.snippets.putState(Actor.USER, s.id(), "big", "\"" + "x".repeat(64 * 1024) + "\"").message()).contains("64 KB");
        assertThat(f.snippets.putState(Actor.USER, s.id(), "filter", null).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.state(s.id()).value()).isEmpty();
    }

    @Test
    void anInlineSnippetKeepsStateByWhereItIsAndGoesWithItsCard() {
        String inline = "inline:card:" + card.card().id() + ":desc:0";
        assertThat(f.snippets.putState(Actor.USER, inline, "n", "3").outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.putShot(inline, 0, PNG, List.of("hello")).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.snippets.state(inline).value()).hasSize(1);
        assertThat(f.snippets.putState(Actor.USER, "inline:card:nope:desc:0", "n", "3").outcome()).isEqualTo(Outcome.NOT_FOUND);
        assertThat(f.snippets.putState(Actor.USER, "inline:table:x:y:0", "n", "3").outcome()).isEqualTo(Outcome.NOT_FOUND);

        Snippet p = page(Actor.USER, "card:" + card.card().id(), "Dash", "x");
        f.snippets.putState(Actor.USER, p.id(), "k", "1");
        f.board.delete(Actor.USER, card.card().id());

        assertThat(f.snippetStore.state(inline)).isEmpty();
        assertThat(f.snippetStore.shot(inline)).isEmpty();
        assertThat(f.snippetStore.find(p.id())).isEmpty();
        assertThat(f.snippetStore.state(p.id())).isEmpty();
    }

    @Test
    void aCyclesPagesAndWhatItsSnippetsKeptGoWithTheCycle() {
        Snippet p = page(Actor.USER, "cycle:c-9", "Cycle page", "x");
        f.snippets.putState(Actor.USER, p.id(), "k", "1");
        f.snippets.putState(Actor.USER, "inline:cycle:c-9:brief:0", "k", "1");
        Snippet other = page(Actor.USER, "cycle:c-8", "Other", "x");

        f.briefs.cycleRemoved("c-9");

        assertThat(f.snippetStore.find(p.id())).isEmpty();
        assertThat(f.snippetStore.state(p.id())).isEmpty();
        assertThat(f.snippetStore.state("inline:cycle:c-9:brief:0")).isEmpty();
        assertThat(f.snippetStore.find(other.id())).isPresent();
    }

    @Test
    void aShotIsAPngWithItsConsoleAndOnlyTheNewestAreKept() {
        Snippet s = page(Actor.USER, "project:odeysys", "Dash", "x");
        assertThat(f.snippets.putShot(s.id(), 1, "data:image/png;base64,AAAA", List.of()).message()).contains("PNG");
        assertThat(f.snippets.putShot(s.id(), 1, "%%%", List.of()).message()).contains("base64");
        for (int v = 1; v <= 7; v++) {
            assertThat(f.snippets.putShot(s.id(), v, PNG, List.of("line " + v, "error: x")).outcome()).isEqualTo(Outcome.OK);
        }
        var shot = f.snippets.shot(s.id()).orElseThrow();
        assertThat(shot.version()).isEqualTo(7);
        assertThat(shot.console()).isEqualTo("line 7\nerror: x");
        assertThat(f.snippets.putShot("nope-nope-nope", 1, PNG, List.of()).outcome()).isEqualTo(Outcome.NOT_FOUND);
    }
}
