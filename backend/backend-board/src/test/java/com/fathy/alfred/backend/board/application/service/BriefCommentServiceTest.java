package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BriefCommentsUseCase.NewComment;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BriefComment;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.StringReader;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/024: comments on a cycle's brief - threads, Claude's questions and suggested rewordings, the user's decisions. */
class BriefCommentServiceTest {

    @TempDir
    Path dir;

    private BoardFixture f;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        f.briefs.putBrief(Actor.USER, "c-1", "Goal\n\n## Scope\n- Branch is no longer required\n- Export uses the filters\n");
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private static NewComment say(String quote, String text) {
        return new NewComment(quote, text, null, false, null, null);
    }

    @Test
    void aCommentOnAPassageAndARepliesJoinItsThread() {
        var root = f.briefComments.add(Actor.USER, "c-1", say("Branch is no longer required", "Still true?"));
        assertThat(root.outcome()).isEqualTo(CardChange.Outcome.OK);
        long id = root.comment().id();
        var reply = f.briefComments.add(Actor.CLAUDE, "c-1", new NewComment("ignored", "Not yet - #52", id, false, null, null));
        // a reply to the reply still joins the thread, and carries no quote of its own
        var again = f.briefComments.add(Actor.USER, "c-1", new NewComment(null, "ok", reply.comment().id(), false, null, null));

        assertThat(reply.comment().replyTo()).isEqualTo(id);
        assertThat(reply.comment().quote()).isNull();
        assertThat(again.comment().replyTo()).isEqualTo(id);
        assertThat(f.briefComments.comments("c-1")).extracting(BriefComment::text).containsExactly("Still true?", "Not yet - #52", "ok");
        assertThat(f.signals).contains("brief-comments:null:c-1");
        assertThat(f.briefComments.comments("c-2")).isEmpty();
    }

    @Test
    void emptyOrOversizedTextAndUnknownThreadsAreRefused() {
        assertThat(f.briefComments.add(Actor.USER, "c-1", say(null, "  ")).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefComments.add(Actor.USER, "c-1", say(null, "x".repeat(16 * 1024 + 1))).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefComments.add(Actor.USER, "c-1", say("q".repeat(2001), "x")).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefComments.add(Actor.USER, "c-1", new NewComment(null, "x", 999L, false, null, null)).outcome())
                .isEqualTo(CardChange.Outcome.NOT_FOUND);
        long other = f.briefComments.add(Actor.USER, "c-2", say(null, "elsewhere")).comment().id();
        assertThat(f.briefComments.add(Actor.USER, "c-1", new NewComment(null, "x", other, false, null, null)).outcome())
                .isEqualTo(CardChange.Outcome.NOT_FOUND);
    }

    @Test
    void onlyTheUserResolvesAndAReplyReopens() {
        long id = f.briefComments.add(Actor.USER, "c-1", say(null, "keep the table in sync")).comment().id();
        assertThat(f.briefComments.resolve(Actor.CLAUDE, "c-1", id, true).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        var done = f.briefComments.resolve(Actor.USER, "c-1", id, true);
        assertThat(done.comment().resolvedAt()).isNotNull();
        assertThat(done.comment().resolvedBy()).isEqualTo(Actor.USER);

        f.briefComments.add(Actor.CLAUDE, "c-1", new NewComment(null, "one more thing", id, false, null, null));
        assertThat(f.briefCommentStore.briefComment(id).orElseThrow().resolvedAt()).isNull();

        f.briefComments.resolve(Actor.USER, "c-1", id, true);
        assertThat(f.briefComments.resolve(Actor.USER, "c-1", id, false).comment().resolvedAt()).isNull();
    }

    @Test
    void onlyClaudeAsksOrSuggestsAndOnlyAboutAPassageTheBriefHolds() {
        assertThat(f.briefComments.add(Actor.USER, "c-1", new NewComment(null, "?", null, true, null, null)).outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefComments.add(Actor.USER, "c-1", new NewComment(null, "x", null, false, "Goal", "Aim")).outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefComments.add(Actor.CLAUDE, "c-1", new NewComment(null, "x", null, false, "not there", "y")).outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
        var asks = f.briefComments.add(Actor.CLAUDE, "c-1", new NewComment("Export uses the filters", "Which filters?", null, true, null, null));
        assertThat(asks.comment().asks()).isTrue();
        assertThat(asks.comment().actor()).isEqualTo(Actor.CLAUDE);
    }

    @Test
    void applyingASuggestionRewordsTheBriefKeepsItRestorableAndFollowsTheQuote() {
        long root = f.briefComments.add(Actor.USER, "c-1", say("Branch is no longer required", "Still true?")).comment().id();
        long sug = f.briefComments.add(Actor.CLAUDE, "c-1", new NewComment(null, "Reword it:", root, false,
                "Branch is no longer required", "Branch should not be required - today it still is (#52)")).comment().id();

        assertThat(f.briefComments.apply(Actor.CLAUDE, "c-1", sug).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        var applied = f.briefComments.apply(Actor.USER, "c-1", sug);
        assertThat(applied.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(applied.brief().text()).contains("Branch should not be required - today it still is (#52)")
                .doesNotContain("Branch is no longer required");
        assertThat(applied.brief().hasPrevious()).isTrue();
        assertThat(applied.comment().hasSuggestion()).isFalse();
        assertThat(f.briefCommentStore.briefComment(root).orElseThrow().quote()).isEqualTo("Branch should not be required - today it still is (#52)");
        // applied once: nothing left to apply
        assertThat(f.briefComments.apply(Actor.USER, "c-1", sug).outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
        assertThat(f.briefs.restoreBrief(Actor.USER, "c-1").brief().text()).contains("Branch is no longer required");
    }

    @Test
    void aSuggestionWhosePassageChangedIsRefusedAndOneCanBeDismissed() {
        long a = f.briefComments.add(Actor.CLAUDE, "c-1", new NewComment(null, "x", null, false, "Export uses the filters", "Export uses the same filters")).comment().id();
        long b = f.briefComments.add(Actor.CLAUDE, "c-1", new NewComment(null, "y", null, false, "Goal", "The goal")).comment().id();
        f.briefs.putBrief(Actor.USER, "c-1", "Goal\n\n## Scope\n- Export is rewritten\n");

        assertThat(f.briefComments.apply(Actor.USER, "c-1", a).outcome()).isEqualTo(CardChange.Outcome.CONFLICT);
        assertThat(f.briefComments.dismiss(Actor.CLAUDE, "c-1", b).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.briefComments.dismiss(Actor.USER, "c-1", b).outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.briefComments.dismiss(Actor.USER, "c-1", b).outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
        assertThat(f.briefs.brief("c-1").text()).startsWith("Goal");
    }

    @Test
    void theCommentsGoWithTheCycle() {
        f.briefComments.add(Actor.USER, "c-1", say(null, "x"));
        f.briefs.cycleRemoved("c-1");
        assertThat(f.briefComments.comments("c-1")).isEmpty();
    }

    @Test
    void anImportBringsThreadsBackOnceWithTheirReplies() throws Exception {
        String file = String.join("\n",
                "{\"format\":\"alfred-board/1\",\"project\":\"p\"}",
                "{\"record\":\"briefComment\",\"cycleId\":\"c-9\",\"id\":7,\"quote\":\"Goal\",\"actor\":\"USER\",\"text\":\"why?\","
                        + "\"createdAt\":\"2026-10-10T09:00:00Z\",\"resolvedAt\":\"2026-10-11T09:00:00Z\",\"resolvedBy\":\"USER\"}",
                "{\"record\":\"briefComment\",\"cycleId\":\"c-9\",\"id\":8,\"actor\":\"CLAUDE\",\"text\":\"because\",\"replyTo\":7,"
                        + "\"createdAt\":\"2026-10-10T09:01:00Z\"}");
        f.imports.importBoard("p", new BufferedReader(new StringReader(file)));
        f.imports.importBoard("p", new BufferedReader(new StringReader(file)));

        var all = f.briefComments.comments("c-9");
        assertThat(all).hasSize(2);
        assertThat(all.get(0).resolvedAt()).isNotNull();
        assertThat(all.get(1).replyTo()).isEqualTo(all.get(0).id());
        assertThat(all.get(1).actor()).isEqualTo(Actor.CLAUDE);
    }
}
