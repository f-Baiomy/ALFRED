package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Post;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Reply;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/022 US6: the digest (no model), ★ decisions handed over, reactions, ask again, questions and the Shared view. */
class ChatDigestServiceTest {

    private static final ChatKey CYCLE = new ChatKey("odeysys", "c-1");

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

    private ChatMessage send(String text) {
        ChatUseCase.Result<ChatMessage> r = f.chat.post(Actor.USER, CYCLE, new Post(text, null, List.of(), null, false, null, List.of()));
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value();
    }

    private ChatMessage answer(ChatMessage q, String text, ObjectNode extra) {
        f.live.chatBeat("odeysys", "c-1", "chat-a", "laptop", "C:/work", "live", true, false);
        assertThat(f.chat.take(Actor.CLAUDE, q.id(), "chat-a", "c-1").isOk()).isTrue();
        var r = f.chat.reply(Actor.CLAUDE, q.id(), new Reply(text, List.of(), List.of(), extra, null));
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value().message();
    }

    @Test
    void theDigestListsWhatChangedOnTheBoardSinceTheLastLookWithoutAModel() {
        Instant before = f.clock.instant().minusSeconds(3600);
        var card = f.add(Actor.CLAUDE, "odeysys", CardKind.BUG, "Search returns one branch", "");
        f.board.comment(Actor.USER, card.card().id(), new com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase.Comment("seen it", null, null, null, null));

        var digest = f.chat.digest(new ChatKey("odeysys", ""), before);
        assertThat(digest).isPresent();
        assertThat(digest.get().lines()).singleElement().asString()
                .contains("@[card:odeysys#" + card.card().number() + "|Search returns one branch]").contains("Claude added it").contains("you commented");

        assertThat(f.chat.digest(new ChatKey("odeysys", ""), f.clock.instant().plusSeconds(5))).as("nothing since").isEmpty();
        assertThat(f.chat.digest(new ChatKey("other", ""), before)).as("another project").isEmpty();
    }

    @Test
    void aStarredMessageIsADecisionInTheBriefAndUnstarringUndoesIt() {
        ChatMessage m = send("We keep the old endpoint for the mobile app");
        var on = f.chat.decision(Actor.USER, m.id(), true);
        assertThat(on.isOk()).as(on.message()).isTrue();
        assertThat(on.value().decision()).isTrue();
        assertThat(f.briefs.brief("c-1").text()).contains("We keep the old endpoint for the mobile app");
        assertThat(f.chat.handover(CYCLE).decisions()).extracting(ChatMessage::id).contains(m.id());
        assertThat(f.chatStore.recordsOf(List.of(m.id()))).extracting(ChatRecord::kind).containsExactly(ChatRecord.Kind.DECISION);
        assertThat(f.chat.decision(Actor.CLAUDE, m.id(), false).outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);

        var off = f.chat.decision(Actor.USER, m.id(), false);
        assertThat(off.isOk()).as(off.message()).isTrue();
        assertThat(off.value().decision()).isFalse();
        assertThat(f.briefs.brief("c-1").text() == null ? "" : f.briefs.brief("c-1").text()).doesNotContain("old endpoint");
    }

    @Test
    void reactionsToggleAndAQuestionMarkOnAnAnswerAsksClaudeToExplainInTheThread() {
        ChatMessage q = send("why 500?");
        ChatMessage a = answer(q, "The null branch.", null);
        assertThat(f.chat.react(Actor.USER, a.id(), "👍").value().reactions()).containsEntry("👍", 1);
        assertThat(f.chat.react(Actor.USER, a.id(), "👍").value().reactions()).doesNotContainKey("👍");
        assertThat(f.chat.react(Actor.USER, a.id(), "💩").outcome()).isEqualTo(Outcome.INVALID);

        f.chat.react(Actor.USER, a.id(), "❓");
        ChatMessage explain = f.chat.page(CYCLE, null, 50).messages().stream().filter(x -> "explain".equals(x.origin())).findFirst().orElseThrow();
        assertThat(explain.state()).isEqualTo(ChatMessage.State.WAITING);
        assertThat(explain.parentId()).as("in the answer's thread").isEqualTo(a.id());
    }

    @Test
    void askingAgainKeepsTheAnswerMarkedAndQueuesTheQuestionWithMoreToRead() {
        ChatMessage q = send("why 500?");
        ChatMessage a = answer(q, "The null branch.", null);
        var again = f.chat.again(Actor.USER, a.id(), new ChatUseCase.AskAgain(true, true, false, "it happens only on Mondays"));
        assertThat(again.isOk()).as(again.message()).isTrue();
        assertThat(again.value().state()).isEqualTo(ChatMessage.State.WAITING);
        assertThat(again.value().origin()).isEqualTo("asked-again");
        assertThat(again.value().text()).contains("why 500?").contains("log lines").contains("SQL").contains("Mondays").doesNotContain("acceptance");
        assertThat(f.chat.message(a.id()).orElseThrow().superseded()).isTrue();
        assertThat(f.chat.again(Actor.USER, a.id(), new ChatUseCase.AskAgain(false, false, false, null)).outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.chat.again(Actor.USER, q.id(), new ChatUseCase.AskAgain(false, false, false, null)).outcome()).isEqualTo(Outcome.NOT_FOUND);
    }

    @Test
    void questionsAreAnsweredSomeAtATimeAndTheAnswersGoBackAsOneMessage() {
        ObjectNode extra = JsonNodeFactory.instance.objectNode();
        var qs = extra.putArray("questions");
        qs.addObject().put("header", "Scope").put("question", "Fix both?").putArray("options").addObject().put("label", "Both");
        qs.addObject().put("header", "When").put("question", "Now?").putArray("options").addObject().put("label", "Now");
        ChatMessage a = answer(send("fix it?"), "Two questions first.", extra);

        var sent = f.chat.answer(Actor.USER, a.id(), Map.of("Scope", "Both"));
        assertThat(sent.isOk()).as(sent.message()).isTrue();
        assertThat(sent.value().text()).contains("**Scope**: Both").doesNotContain("When");
        assertThat(sent.value().state()).isEqualTo(ChatMessage.State.WAITING);
        assertThat(f.chat.message(a.id()).orElseThrow().extra().path("questions").get(0).path("answer").asText()).isEqualTo("Both");
        assertThat(f.chat.message(a.id()).orElseThrow().extra().path("questions").get(1).has("answer")).isFalse();
        assertThat(f.chat.answer(Actor.USER, a.id(), Map.of("Scope", "again")).outcome()).as("already answered").isEqualTo(Outcome.CONFLICT);
        assertThat(f.chat.answer(Actor.CLAUDE, a.id(), Map.of("When", "Now")).outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void theSharedViewListsEveryMentionOnceWithItsFirstMessage() {
        ChatMessage first = send("look at @[call:in:abc|POST /x · 500] and @[card:odeysys#3|Search]");
        send("again @[call:in:abc|POST /x · 500]");
        var groups = f.chat.shared(CYCLE);
        assertThat(groups).extracting(ChatUseCase.SharedGroup::type).containsExactly("call", "card");
        assertThat(groups.get(0).refs()).singleElement().satisfies(r -> {
            assertThat(r.messageId()).isEqualTo(first.id());
            assertThat(r.mention()).containsEntry("ref", "in:abc").containsEntry("type", "call");
        });
    }
}
