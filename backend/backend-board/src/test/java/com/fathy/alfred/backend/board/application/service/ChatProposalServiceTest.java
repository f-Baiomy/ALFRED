package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.in.ChatProposalUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Post;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Reply;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.Mark;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/022 US7: proposals re-checked at accept, stale ones never applied, bulk partial, Undo for 60 seconds, consent. */
class ChatProposalServiceTest {

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

    private int card(String title, CardStatus status) {
        var c = f.add(Actor.USER, "odeysys", CardKind.BUG, title, "");
        if (status != CardStatus.INBOX) {
            assertThat(f.board.move(Actor.USER, c.card().id(), status).outcome()).isEqualTo(Outcome.OK);
        }
        return c.card().number();
    }

    private CardStatus status(int number) {
        return f.store.findByNumber("odeysys", number).orElseThrow().status();
    }

    private ChatMessage answerWith(ObjectNode extra) {
        ChatMessage q = f.chat.post(Actor.USER, CYCLE, new Post("what next?", null, List.of(), null, false, null, List.of())).value();
        f.live.chatBeat("odeysys", "c-1", "chat-a", "laptop", "C:/work", "live", true, false);
        assertThat(f.chat.take(Actor.CLAUDE, q.id(), "chat-a", "c-1").isOk()).isTrue();
        var r = f.chat.reply(Actor.CLAUDE, q.id(), new Reply("Here is what I propose.", List.of(), List.of(), extra, null));
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value().message();
    }

    @Test
    void acceptedProposalsAreAppliedAsTheUserStaleOnesNeverAndUndoPutsThemBackWithinAMinute() {
        int fixed = card("Search returns one branch", CardStatus.FIXED);
        int toClose = card("Slow page", CardStatus.TO_DO);
        int toMove = card("Typo in the title", CardStatus.INBOX);
        assertThat(f.briefs.put(Actor.USER, "c-1", "spec.md", "## Acceptance\n- [ ] Branch filter keeps both branches\n").outcome()).isEqualTo(Outcome.OK);
        String key = f.briefs.checklist("c-1").get(0).items().get(0).key();

        ObjectNode extra = JsonNodeFactory.instance.objectNode();
        ArrayNode ps = extra.putArray("proposals");
        ps.addObject().put("id", "v").put("kind", "verify").put("card", fixed).put("text", "verify #" + fixed);
        ps.addObject().put("id", "c").put("kind", "close").put("card", toClose).put("text", "close #" + toClose + " as Fine");
        ps.addObject().put("id", "m").put("kind", "move").put("card", toMove).put("status", "TO_DO").put("text", "move #" + toMove + " to To do");
        ps.addObject().put("id", "k").put("kind", "mark").put("file", "spec.md").put("itemKey", key).put("mark", "PASS").put("evidence", "@[call:in:a|x]");
        ps.addObject().put("id", "i").put("kind", "item").put("file", "spec.md").put("item", "The total shows both branches").put("text", "add AC");
        ChatMessage a = answerWith(extra);

        f.board.move(Actor.USER, f.store.findByNumber("odeysys", toMove).orElseThrow().id(), CardStatus.TO_DO); // the user did it meanwhile
        assertThat(f.proposals.check(a.id()).value()).containsEntry("v", null).containsEntry("m", "already done");

        var out = f.proposals.decide(Actor.USER, a.id(), List.of("v", "m", "k", "nope"), List.of("c"));
        assertThat(out.isOk()).as(out.message()).isTrue();
        assertThat(out.value().results()).containsEntry("v", "applied").containsEntry("m", "already done").containsEntry("k", "applied")
                .containsEntry("c", "declined").containsEntry("nope", "no such proposal");
        assertThat(status(fixed)).isEqualTo(CardStatus.VERIFIED);
        assertThat(status(toClose)).as("declined").isEqualTo(CardStatus.TO_DO);
        assertThat(f.briefs.checklist("c-1").get(0).items().get(0).mark().mark()).isEqualTo(Mark.PASS);
        assertThat(f.proposals.check(a.id()).value()).containsOnlyKeys("i");
        assertThat(f.proposals.decide(Actor.USER, a.id(), List.of("v"), List.of()).value().results()).containsEntry("v", "already applied");

        var undo = f.proposals.undo(Actor.USER, out.value().undoToken());
        assertThat(undo.message()).as("a fresh mark cannot be cleared - said, the rest put back").contains("cannot be cleared");
        assertThat(status(fixed)).isEqualTo(CardStatus.FIXED);
        assertThat(f.proposals.check(a.id()).value()).as("reopened").containsKeys("v", "k", "i");
        assertThat(f.proposals.undo(Actor.USER, out.value().undoToken()).outcome()).as("once").isEqualTo(Outcome.CONFLICT);
    }

    @Test
    void anAppliedProposalCanBeUndoneLaterWhileTheBoardIsStillAsItLeftIt() {
        int toClose = card("Export with no rows", CardStatus.TO_DO);
        int toMove = card("Typo", CardStatus.INBOX);
        ObjectNode extra = JsonNodeFactory.instance.objectNode();
        ArrayNode ps = extra.putArray("proposals");
        ps.addObject().put("id", "c").put("kind", "close").put("card", toClose).put("reason", "cannot be clicked without rows");
        ps.addObject().put("id", "m").put("kind", "move").put("card", toMove).put("status", "TO_DO");
        ChatMessage a = answerWith(extra);
        assertThat(f.proposals.decide(Actor.USER, a.id(), List.of("c", "m"), List.of()).isOk()).isTrue();
        assertThat(status(toClose)).isEqualTo(CardStatus.CLOSED);
        f.clock.advanceSeconds(600); // long after the toast's minute

        assertThat(f.proposals.undoOne(Actor.CLAUDE, a.id(), "c").outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        var undone = f.proposals.undoOne(Actor.USER, a.id(), "c");
        assertThat(undone.isOk()).as(undone.message()).isTrue();
        assertThat(status(toClose)).as("reopened").isNotEqualTo(CardStatus.CLOSED);
        assertThat(f.proposals.check(a.id()).value()).as("open again, can be accepted again").containsEntry("c", null);

        f.board.move(Actor.USER, f.store.findByNumber("odeysys", toMove).orElseThrow().id(), CardStatus.IN_PROGRESS);
        var refused = f.proposals.undoOne(Actor.USER, a.id(), "m");
        assertThat(refused.outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(refused.message()).contains("changed since");
        assertThat(status(toMove)).as("the user's later move stays").isEqualTo(CardStatus.IN_PROGRESS);
        assertThat(f.proposals.undoOne(Actor.USER, a.id(), "c").outcome()).as("not applied any more").isEqualTo(Outcome.CONFLICT);
    }

    @Test
    void undoIsRefusedAfterTheMinuteAndAcceptingIsTheUsers() {
        int fixed = card("Search", CardStatus.FIXED);
        ObjectNode extra = JsonNodeFactory.instance.objectNode();
        extra.putArray("proposals").addObject().put("id", "v").put("kind", "verify").put("card", fixed);
        ChatMessage a = answerWith(extra);
        assertThat(f.proposals.decide(Actor.CLAUDE, a.id(), List.of("v"), List.of()).outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);

        ChatProposalUseCase.Outcome out = f.proposals.decide(Actor.USER, a.id(), List.of("v"), List.of()).value();
        f.clock.advanceSeconds(ChatProposalUseCase.UNDO_SECONDS + 1);
        assertThat(f.proposals.undo(Actor.USER, out.undoToken()).outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(status(fixed)).isEqualTo(CardStatus.VERIFIED);
    }

    @Test
    void anOutdatedProposalSaysWhyAndANewItemGoesAtTheEndOfTheSpecAndComesOutOnUndo() {
        int inbox = card("Not fixed yet", CardStatus.INBOX);
        assertThat(f.briefs.put(Actor.USER, "c-1", "spec.md", "## Acceptance\n- [ ] One\n").outcome()).isEqualTo(Outcome.OK);
        ObjectNode extra = JsonNodeFactory.instance.objectNode();
        ArrayNode ps = extra.putArray("proposals");
        ps.addObject().put("id", "v").put("kind", "verify").put("card", inbox);
        ps.addObject().put("id", "i").put("kind", "item").put("file", "spec.md").put("item", "Two");
        ChatMessage a = answerWith(extra);

        var out = f.proposals.decide(Actor.USER, a.id(), List.of("v", "i"), List.of()).value();
        assertThat(out.results().get("v")).startsWith("outdated:").contains("not Fixed");
        assertThat(out.results()).containsEntry("i", "applied");
        assertThat(f.store.spec("c-1", "spec.md").orElseThrow().content()).contains("- [ ] One").contains("- [ ] Two");
        assertThat(f.chat.message(a.id()).orElseThrow().extra().path("proposals").get(0).path("state").asText()).isEqualTo("outdated");

        assertThat(f.proposals.undo(Actor.USER, out.undoToken()).isOk()).isTrue();
        assertThat(f.store.spec("c-1", "spec.md").orElseThrow().content()).doesNotContain("Two");
    }

    @Test
    void aConsentIsDecidedOnceAndOnlyByTheUser() {
        ObjectNode extra = JsonNodeFactory.instance.objectNode();
        extra.putObject("consent").put("kind", "resend").put("summary", "resend POST /x").put("call", "in:a");
        ChatMessage a = answerWith(extra);
        assertThat(f.proposals.consent(Actor.CLAUDE, a.id(), true).outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.proposals.consent(Actor.USER, a.id(), true).isOk()).isTrue();
        assertThat(f.chat.message(a.id()).orElseThrow().extra().path("consent").path("decided").asText()).isEqualTo("yes");
        assertThat(f.proposals.consent(Actor.USER, a.id(), false).outcome()).isEqualTo(Outcome.CONFLICT);
        ChatUseCase.Result<?> none = f.proposals.consent(Actor.USER, 999_999, true);
        assertThat(none.outcome()).isEqualTo(Outcome.NOT_FOUND);
    }
}
