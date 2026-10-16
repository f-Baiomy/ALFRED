package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardImagesUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentExtrasUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardImageStorePort;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.TextVersion;
import com.fathy.alfred.backend.board.domain.model.Waiting;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Rich text on the board: HTML cleaned on save, reactions, the user's edits with their history, pictures that go with their card. */
class BoardRichTextTest {

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

    private String card() {
        return f.add(Actor.USER, "p", CardKind.BUG, "Fare changes", "").card().id();
    }

    private ActivityEntry comment(Actor actor, String id, String text) {
        CommentOnCardUseCase.CommentOutcome out = actor == Actor.CLAUDE
                ? f.board.comment(actor, id, new CommentOnCardUseCase.Comment(null, "did", "found", "next", null))
                : f.board.comment(actor, id, new CommentOnCardUseCase.Comment(text, null, null, null, null));
        assertThat(out.outcome()).as(out.message()).isEqualTo(CardChange.Outcome.OK);
        return out.entry();
    }

    @Test
    void aUsersHtmlCommentIsCleanedAndItsMentionsIndexed() {
        String id = card();

        ActivityEntry e = comment(Actor.USER, id, "<p>Look at @[call:in:c1|GET /a] <script>x()</script><b>now</b></p>");

        assertThat(e.text()).isEqualTo("<p>Look at @[call:in:c1|GET /a] <b>now</b></p>");
        assertThat(f.store.mentionsOf(MentionOwner.ACTIVITY, Long.toString(e.id()))).hasSize(1);
    }

    @Test
    void aMarkdownCommentStaysMarkdown() {
        String id = card();

        assertThat(comment(Actor.USER, id, "**ok** <go>").text()).isEqualTo("**ok** <go>");
    }

    @Test
    void reactionsToggleAndAGoOnClaudesPlanIsClaudesTurn() {
        String id = card();
        ActivityEntry plan = comment(Actor.CLAUDE, id, null);

        assertThat(f.board.react(Actor.USER, id, plan.id(), "✅").on()).isTrue();
        assertThat(f.store.activity(id, 0, 100)).filteredOn(x -> x.kind() == ActivityKind.REACTION)
                .extracting(ActivityEntry::text, ActivityEntry::replyTo).containsExactly(org.assertj.core.groups.Tuple.tuple("✅", plan.id()));
        assertThat(f.store.waiting(id).map(w -> w.who())).contains(Waiting.CLAUDE);

        assertThat(f.board.react(Actor.USER, id, plan.id(), "✅").on()).isFalse();
        assertThat(f.store.activity(id, 0, 100)).noneMatch(x -> x.kind() == ActivityKind.REACTION);
    }

    @Test
    void onlyTheUserReactsAndOnlyWithTheBoardsReactions() {
        String id = card();
        ActivityEntry c = comment(Actor.USER, id, "hi");

        assertThat(f.board.react(Actor.CLAUDE, id, c.id(), "👍").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.react(Actor.USER, id, c.id(), "💩").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.react(Actor.USER, id, 999_999, "👍").outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
        assertThat(CommentExtrasUseCase.REACTIONS).contains("👍", "✅", "🤔");
    }

    @Test
    void aReplyToAReplyStaysInTheThreadAndKeepsTheReplyItAnswers() {
        String id = card();
        ActivityEntry root = comment(Actor.USER, id, "the agencies list is empty");
        ActivityEntry first = reply(id, root.id(), "is that the same for the export?");
        ActivityEntry second = reply(id, first.id(), "fix both then");

        // the thread is still the first comment's; the tree is told by the reply it was written to (specs/023)
        assertThat(first.replyTo()).isEqualTo(root.id());
        assertThat(first.answers()).isNull();
        assertThat(second.replyTo()).isEqualTo(root.id());
        assertThat(second.answers()).isEqualTo(first.id());
        ActivityEntry stored = f.store.activityEntry(second.id()).orElseThrow();
        assertThat(stored.replyTo()).isEqualTo(root.id());
        assertThat(stored.answers()).isEqualTo(first.id());
        assertThat(f.store.activity(id, 0, 100)).filteredOn(e -> e.id() == second.id()).extracting(ActivityEntry::answers).containsExactly(first.id());
    }

    private ActivityEntry reply(String id, long to, String text) {
        CommentOnCardUseCase.CommentOutcome out = f.board.comment(Actor.USER, id,
                new CommentOnCardUseCase.Comment(text, null, null, null, null, null, null, to, false));
        assertThat(out.outcome()).as(out.message()).isEqualTo(CardChange.Outcome.OK);
        return out.entry();
    }

    @Test
    void theUserEditsTheirOwnCommentAndTheEarlierTextIsKept() {
        String id = card();
        ActivityEntry c = comment(Actor.USER, id, "first @[call:in:c1|GET /a]");
        f.clock.advanceSeconds(120);

        CommentExtrasUseCase.Outcome out = f.board.editComment(Actor.USER, id, c.id(), "<p>second @[call:in:c2|GET /b]</p>");

        assertThat(out.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.store.activityEntry(c.id()).orElseThrow().text()).isEqualTo("<p>second @[call:in:c2|GET /b]</p>");
        assertThat(f.board.versions("comment:" + c.id())).extracting(TextVersion::text).containsExactly("first @[call:in:c1|GET /a]");
        assertThat(f.store.mentionsOf(MentionOwner.ACTIVITY, Long.toString(c.id()))).extracting(m -> m.ref().ref()).containsExactly("in:c2");
        assertThat(f.store.activity(id, 0, 100)).anyMatch(x -> x.kind() == ActivityKind.COMMENT_EDITED && Long.valueOf(c.id()).equals(x.replyTo()));
    }

    @Test
    void nobodyEditsClaudesCommentsAndClaudeEditsNone() {
        String id = card();
        ActivityEntry claude = comment(Actor.CLAUDE, id, null);
        ActivityEntry mine = comment(Actor.USER, id, "x");

        assertThat(f.board.editComment(Actor.USER, id, claude.id(), "y").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.editComment(Actor.CLAUDE, id, mine.id(), "y").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void aDescriptionsEarlierTextIsKeptWhenItChanges() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "old words").card().id();

        f.board.update(Actor.USER, id, new UpdateCardUseCase.CardEdit(null, "<h2>New</h2><p>words</p>", null, null, null, null, null));

        assertThat(f.board.versions("description:" + id)).extracting(TextVersion::text).containsExactly("old words");
        assertThat(f.board.versions("description:x' OR 1=1")).isEmpty();
    }

    @Test
    void aPictureBelongsToTheCardWhoseTextShowsItAndOnlyRealPicturesAreKept() {
        BoardImagesService images = new BoardImagesService((BoardImageStorePort) f.store, f.clock);
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0};

        BoardImagesUseCase.Saved saved = images.save("image/png", png);
        assertThat(saved.error()).isNull();
        assertThat(images.save("image/png", "<svg onload=x>".getBytes()).error()).contains("not a PNG");
        assertThat(images.save("image/svg+xml", png).error()).contains("PNG, JPEG");

        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "<p>see</p><img src=\"/board/images/" + saved.id() + "\">").card().id();
        assertThat(images.image(saved.id())).get().extracting(i -> i.cardId()).isEqualTo(id);

        BoardImagesUseCase.Saved stray = images.save("image/png", png);
        f.clock.advanceSeconds(2 * 86_400);
        images.save("image/png", png); // the next upload sweeps the pictures no text showed
        assertThat(images.image(stray.id())).isEmpty();
        assertThat(images.image(saved.id())).isPresent();
    }

    @Test
    void anHtmlBriefIsCleaned() {
        assertThat(f.briefs.putBrief(Actor.USER, "cy", "<p>Goal <img src=x onerror=alert(1)></p>").brief().text()).isEqualTo("<p>Goal </p>");
    }

    @Test
    void anImportCleansItsHtmlAndBringsItsPicturesWithTheCard() throws Exception {
        var json = new com.fasterxml.jackson.databind.ObjectMapper();
        var b64 = java.util.Base64.getEncoder();
        Map<String, Object> card = new java.util.LinkedHashMap<>();
        card.put("project", "src");
        card.put("number", 1);
        card.put("kind", "BUG");
        card.put("title", "t");
        card.put("description", "<p>shot <img src='/board/images/pic-00001'><script>x()</script></p>");
        card.put("status", "INBOX");
        card.put("scope", "NOT_DECIDED");
        card.put("author", "USER");
        card.put("createdAt", "2026-10-14T09:00:00Z");
        card.put("updatedAt", "2026-10-14T09:00:00Z");
        card.put("updatedBy", "USER");
        String file = String.join(System.lineSeparator(),
                json.writeValueAsString(Map.of("format", "alfred-board/1")),
                json.writeValueAsString(Map.of("record", "card", "card", card, "links", List.of())),
                json.writeValueAsString(Map.of("record", "activity", "cardNumber", 1, "entry", Map.of("id", 5, "actor", "USER", "kind", "COMMENT",
                        "text", "<p onclick='x()'>hi</p>", "at", "2026-10-14T09:01:00Z"))),
                json.writeValueAsString(Map.of("record", "image", "id", "pic-00001", "mime", "image/png",
                        "data", b64.encodeToString(new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0}))),
                json.writeValueAsString(Map.of("record", "image", "id", "pic-00002", "mime", "image/png",
                        "data", b64.encodeToString("<svg onload=x>".getBytes())))) + System.lineSeparator();
        f.imports.importBoard("dest", new java.io.BufferedReader(new java.io.StringReader(file)));

        var imported = f.store.findByNumber("dest", 1).orElseThrow();
        assertThat(imported.description()).isEqualTo("<p>shot <img src=\"/board/images/pic-00001\"></p>");
        assertThat(f.store.activity(imported.id(), 0, 100).stream().filter(e -> e.kind() == ActivityKind.COMMENT).findFirst().orElseThrow().text())
                .isEqualTo("<p>hi</p>");
        BoardImageStorePort images = (BoardImageStorePort) f.store;
        assertThat(images.findImage("pic-00001")).get().extracting(i -> i.cardId()).isEqualTo(imported.id());
        assertThat(images.findImage("pic-00002")).isEmpty(); // not a real PNG
    }

    @SuppressWarnings("unused")
    private static List<String> kinds(List<ActivityEntry> all) {
        return all.stream().map(e -> e.kind().name()).toList();
    }
}
