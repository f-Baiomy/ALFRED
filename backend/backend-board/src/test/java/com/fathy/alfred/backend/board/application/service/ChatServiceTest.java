package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Post;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.RecordRequest;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Reply;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Result;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.ToTerminal;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatMessage.State;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/022: the chat's states, who takes what, the answer with its records and terminal items, compaction. */
class ChatServiceTest {

    private static final ChatKey CYCLE = new ChatKey("odeysys", "c-1");
    private static final ChatKey PROJECT = new ChatKey("odeysys", "");

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

    private ChatMessage send(ChatKey chat, String text) {
        Result<ChatMessage> r = f.chat.post(Actor.USER, chat, new Post(text, null, List.of(), null, false, null, List.of()));
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value();
    }

    private void holdCycle(String chatId) {
        f.live.chatBeat("odeysys", "c-1", chatId, "laptop", "C:/work", "live", true, false);
    }

    private ChatMessage takeAndAnswer(ChatMessage m, String text, List<RecordRequest> records) {
        assertThat(f.chat.take(Actor.CLAUDE, m.id(), "chat-a", m.chat().isProject() ? null : m.chat().cycleId()).isOk()).isTrue();
        Result<ChatUseCase.Replied> r = f.chat.reply(Actor.CLAUDE, m.id(), new Reply(text, records, List.of(), null, null));
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value().message();
    }

    @Test
    void aMessageWaitsIsTakenOnceAndAnsweredInItsThread() {
        holdCycle("chat-a");
        ChatMessage parent = send(CYCLE, "first");
        ChatMessage m = f.chat.post(Actor.USER, CYCLE, new Post("why 500?", parent.id(), List.of(), null, false, null, List.of())).value();
        assertThat(m.state()).isEqualTo(State.WAITING);
        assertThat(f.signals).contains("chat:odeysys:c-1:" + m.id());

        assertThat(f.chat.take(Actor.CLAUDE, m.id(), "chat-b", "c-1").outcome()).isEqualTo(Outcome.CONFLICT);
        Result<ChatUseCase.Taken> taken = f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1");
        assertThat(taken.isOk()).isTrue();
        assertThat(taken.value().thread()).extracting(ChatMessage::id).containsExactly(parent.id());
        assertThat(f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1").outcome()).isEqualTo(Outcome.CONFLICT);

        Result<ChatUseCase.Replied> replied = f.chat.reply(Actor.CLAUDE, m.id(), new Reply("Because of the null branch.", List.of(), List.of(), null, null));
        assertThat(replied.isOk()).isTrue();
        ChatMessage answer = replied.value().message();
        assertThat(answer.replyTo()).isEqualTo(m.id());
        assertThat(answer.parentId()).isEqualTo(parent.id());
        assertThat(f.chat.message(m.id()).orElseThrow().state()).isEqualTo(State.ANSWERED);
        assertThat(f.chat.answerOf(m.id())).get().extracting(ChatMessage::id).isEqualTo(answer.id());
        assertThat(f.chat.reply(Actor.CLAUDE, m.id(), new Reply("again", List.of(), List.of(), null, null)).outcome()).isEqualTo(Outcome.CONFLICT);
    }

    @Test
    void onlyTheUserEditsOrCancelsAndOnlyWhileWaiting() {
        ChatMessage m = send(CYCLE, "draft");
        assertThat(f.chat.edit(Actor.CLAUDE, m.id(), "x").outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.chat.edit(Actor.USER, m.id(), "better").value().text()).isEqualTo("better");
        assertThat(f.chat.urgent(Actor.USER, m.id()).value().urgent()).isTrue();
        holdCycle("chat-a");
        f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1");
        assertThat(f.chat.edit(Actor.USER, m.id(), "late").outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.chat.cancel(Actor.USER, m.id()).outcome()).isEqualTo(Outcome.CONFLICT);

        ChatMessage other = send(CYCLE, "never mind");
        assertThat(f.chat.cancel(Actor.USER, other.id()).value().state()).isEqualTo(State.CANCELLED);
        assertThat(f.chat.post(Actor.CLAUDE, CYCLE, new Post("hi", null, List.of(), null, false, null, List.of())).outcome())
                .isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.chat.post(Actor.USER, CYCLE, new Post("  ", null, List.of(), null, false, null, List.of())).outcome()).isEqualTo(Outcome.INVALID);
    }

    @Test
    void urgentMessagesComeFirstInTheChangesAndTheChangesWakeOnAChatMessage() {
        ChatMessage first = send(CYCLE, "first");
        ChatMessage urgent = f.chat.post(Actor.USER, CYCLE, new Post("now", null, List.of(), null, true, null, List.of())).value();
        BoardChanges changes = f.insights.changes("", "odeysys", null, Actor.USER, 50);
        assertThat(changes.chats()).extracting(c -> c.messageId()).containsExactly(first.id(), urgent.id());
        assertThat(changes.chats().get(1).urgent()).isTrue();
        assertThat(changes.isEmpty()).isFalse();
        BoardChanges next = f.insights.changes(changes.cursor(), "odeysys", null, Actor.USER, 50);
        assertThat(next.chats()).isEmpty();
        assertThat(f.insights.changes(changes.cursor(), "odeysys", null, Actor.CLAUDE, 50).chats()).isEmpty();
        assertThat(f.insights.changes("", "odeysys", null, Actor.CLAUDE, 50).chats()).isEmpty();
    }

    @Test
    void aMessageTakenByARunnerThatWentAwayWaitsAgainForTheNextOne() {
        holdCycle("chat-a");
        ChatMessage m = send(CYCLE, "q");
        f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1");
        String cursor = f.insights.changes("", "odeysys", null, Actor.USER, 50).cursor();

        f.live.chatBeat("odeysys", "c-1", "chat-a", "laptop", null, "live", true, true);
        holdCycle("chat-b");
        f.chat.runnerStarted("odeysys", "c-1", "chat-b");

        assertThat(f.chat.message(m.id()).orElseThrow().state()).isEqualTo(State.WAITING);
        assertThat(f.insights.changes(cursor, "odeysys", null, Actor.USER, 50).chats()).extracting(c -> c.messageId()).containsExactly(m.id());
        // the runner that took it restarting keeps it
        f.chat.take(Actor.CLAUDE, m.id(), "chat-b", "c-1");
        f.chat.runnerStarted("odeysys", "c-1", "chat-b");
        assertThat(f.chat.message(m.id()).orElseThrow().state()).isEqualTo(State.TAKEN);
    }

    @Test
    void aRunThatFailsOrIsStoppedStopsTheMessageWithALine() {
        holdCycle("chat-a");
        ChatMessage m = send(CYCLE, "q");
        f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1");
        f.chat.runEnded(m.id(), LiveWork.State.FAILED, "rate limit");
        assertThat(f.chat.message(m.id()).orElseThrow().state()).isEqualTo(State.STOPPED);
        assertThat(f.chat.page(CYCLE, null, 50).messages()).anyMatch(x -> x.kind() == ChatMessage.Kind.SYSTEM && x.text().contains("rate limit"));
    }

    @Test
    void theProjectChatIsAnsweredOnlyByTheProjectsLiveRunner() {
        ChatMessage m = send(PROJECT, "across cycles?");
        assertThat(f.chat.take(Actor.CLAUDE, m.id(), "chat-a", null).outcome()).isEqualTo(Outcome.CONFLICT);
        f.live.beat("odeysys", "laptop", null, "live", false);
        assertThat(f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1").outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.chat.take(Actor.CLAUDE, m.id(), "runner", null).isOk()).isTrue();

        ChatMessage cycleMessage = send(CYCLE, "q");
        assertThat(f.chat.take(Actor.CLAUDE, cycleMessage.id(), "runner", null).outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.chat.chats("odeysys")).anyMatch(r -> r.summary().scope().equals("project") && r.claudeOn());
    }

    @Test
    void autoCompactQueuesOneTaskAtTheCountAndASummaryNeverFoldsAMessageStillWaiting() {
        f.chat.putSettings(Actor.USER, new ChatSettings(CYCLE, 20, 30, false));
        holdCycle("chat-a");
        for (int i = 0; i < 19; i++) {
            takeAndAnswer(send(CYCLE, "m" + i), "a" + i, List.of());
        }
        assertThat(openCompactTasks()).hasSize(1); // 38 messages since no summary: reached at the 20th
        ChatMessage waiting = send(CYCLE, "still waiting");
        assertThat(openCompactTasks()).hasSize(1);

        Result<ChatMessage> summary = f.chat.summary(Actor.CLAUDE, CYCLE, "We decided X.", waiting.id() + 5);
        assertThat(summary.isOk()).as(summary.message()).isTrue();
        assertThat(summary.value().coversTo()).isLessThan(waiting.id());
        assertThat(openCompactTasks()).isEmpty();
        assertThat(f.chat.page(CYCLE, null, 100).messages()).hasSizeGreaterThan(38); // nothing deleted
        assertThat(f.chat.terminal(CYCLE)).anyMatch(t -> "compact".equals(t.reason()));
        assertThat(f.chat.summary(Actor.CLAUDE, CYCLE, "again", summary.value().coversTo()).outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.chat.summary(Actor.USER, CYCLE, "mine", 3).outcome()).isEqualTo(Outcome.INVALID);
    }

    @Test
    void autoCompactOffNeverQueues() {
        f.chat.putSettings(Actor.USER, new ChatSettings(CYCLE, 0, 30, false));
        for (int i = 0; i < 30; i++) {
            send(CYCLE, "m" + i);
        }
        assertThat(openCompactTasks()).isEmpty();
        assertThat(f.chat.compact(Actor.USER, CYCLE).value().kind()).isEqualTo(ChatMessage.Kind.TASK);
        assertThat(f.chat.compact(Actor.USER, CYCLE).value().id()).isEqualTo(openCompactTasks().get(0).id());
    }

    private List<ChatMessage> openCompactTasks() {
        return f.chatStore.openTasks(CYCLE).stream().filter(t -> "compact".equals(t.origin())).toList();
    }

    @Test
    void recordsAreWrittenAsClaudeAndUndoneByTheUser() {
        holdCycle("chat-a");
        f.briefs.putBrief(Actor.USER, "c-1", "Booking flow.");
        ChatMessage answer = takeAndAnswer(send(CYCLE, "decide?"), "Keep branch filters.", List.of(
                new RecordRequest(ChatRecord.Kind.DECISION, "Keep branch filters", null, null, null),
                new RecordRequest(ChatRecord.Kind.CARD, "Search ignores the branch", new ChatUseCase.NewCardPart("BUG", "Search ignores the branch", ""),
                        null, null),
                new RecordRequest(ChatRecord.Kind.ITEM, "One branch returns only its requests", null,
                        new ChatUseCase.ItemPart("spec.md", "One branch returns only its requests", null), null)));
        List<ChatRecord> records = f.chatStore.recordsOf(List.of(answer.id()));
        assertThat(records).extracting(ChatRecord::kind).containsExactly(ChatRecord.Kind.DECISION, ChatRecord.Kind.CARD, ChatRecord.Kind.ITEM);
        assertThat(f.briefs.brief("c-1").text()).contains("**Decision** (chat #" + answer.id() + "): Keep branch filters");
        var card = f.store.findByNumber("odeysys", 1).orElseThrow();
        assertThat(card.status()).isEqualTo(CardStatus.INBOX);
        assertThat(card.author()).isEqualTo(Actor.CLAUDE);
        assertThat(f.chat.message(answer.id()).orElseThrow().extra().path("proposals")).hasSize(1);
        assertThat(f.chat.chats("odeysys")).anyMatch(r -> r.summary().proposals() == 1);

        for (ChatRecord r : records) {
            assertThat(f.chat.undoRecord(Actor.USER, r.id()).isOk()).isTrue();
        }
        assertThat(f.briefs.brief("c-1").text()).isEqualTo("Booking flow.");
        assertThat(f.store.findByNumber("odeysys", 1)).isEmpty();
        assertThat(f.chat.message(answer.id()).orElseThrow().extra().path("proposals")).isEmpty();
        assertThat(f.chat.undoRecord(Actor.USER, records.get(0).id()).outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.chat.undoRecord(Actor.CLAUDE, records.get(1).id()).outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void aBriefChangedSinceTheDecisionIsNotOverwrittenByUndo() {
        holdCycle("chat-a");
        ChatMessage answer = takeAndAnswer(send(CYCLE, "decide?"), "ok", List.of(new RecordRequest(ChatRecord.Kind.DECISION, "X", null, null, null)));
        f.briefs.putBrief(Actor.USER, "c-1", "rewritten by the user");
        ChatRecord r = f.chatStore.recordsOf(List.of(answer.id())).get(0);
        Result<Void> undo = f.chat.undoRecord(Actor.USER, r.id());
        assertThat(undo.outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.briefs.brief("c-1").text()).isEqualTo("rewritten by the user");
    }

    @Test
    void aFixRecordReportsOnTheCardAndMovesItToFixedAndARefusedRecordSaysWhy() {
        holdCycle("chat-a");
        f.board.create(Actor.USER, new CreateCardUseCase.NewCard("odeysys", CardKind.BUG, "Search 500", "", Set.of(), "c-1", CardStatus.IN_PROGRESS, List.of()));
        ChatMessage answer = takeAndAnswer(send(CYCLE, "fixed?"), "Fixed the null branch.", List.of(
                new RecordRequest(ChatRecord.Kind.FIX, "Null branch", null, null, new ChatUseCase.FixPart(1, "Guarded the null branch.", "Search again")),
                new RecordRequest(ChatRecord.Kind.FIX, "Missing", null, null, new ChatUseCase.FixPart(99, "x", null))));
        assertThat(f.store.findByNumber("odeysys", 1).orElseThrow().status()).isEqualTo(CardStatus.FIXED);
        assertThat(f.chatStore.recordsOf(List.of(answer.id()))).hasSize(1);
        assertThat(f.chat.page(CYCLE, null, 50).messages()).anyMatch(x -> x.kind() == ChatMessage.Kind.SYSTEM && x.text().contains("No card #99"));
        ChatRecord fix = f.chatStore.recordsOf(List.of(answer.id())).get(0);
        assertThat(f.chat.undoRecord(Actor.USER, fix.id()).isOk()).isTrue();
        assertThat(f.store.findByNumber("odeysys", 1).orElseThrow().status()).isEqualTo(CardStatus.IN_PROGRESS);
    }

    @Test
    void terminalItemsAreHeldWithoutARunnerAndUndoneOnlyBeforeTheyAreRead() {
        ChatMessage m = send(CYCLE, "q");
        holdCycle("chat-a");
        f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1");
        Result<ChatUseCase.Replied> r = f.chat.reply(Actor.CLAUDE, m.id(), new Reply("a", List.of(), List.of(
                new ToTerminal("you asked: q / Claude answered: a", false, "exchange", true),
                new ToTerminal("contradicts your step", true, "contradicts", false)), null, null));
        List<TerminalItem> items = r.value().terminal();
        assertThat(items).extracting(TerminalItem::state).containsOnly(TerminalItem.State.SENT);
        assertThat(items.get(1).urgent()).isTrue();
        f.chat.delivered(Actor.CLAUDE, List.of(items.get(0).id()), true);
        assertThat(f.chat.undoTerminal(Actor.USER, items.get(0).id()).outcome()).isEqualTo(Outcome.CONFLICT);
        assertThat(f.chat.undoTerminal(Actor.USER, items.get(1).id()).isOk()).isTrue();

        f.live.chatBeat("odeysys", "c-1", "chat-a", "laptop", null, "live", true, true);
        ChatMessage n = send(CYCLE, "q2");
        // no runner holds the cycle now: what goes to the terminal waits for the next one
        f.chatStore.take(n.id(), "x", java.time.Instant.now());
        List<TerminalItem> held = f.chat.reply(Actor.CLAUDE, n.id(), new Reply("b", List.of(),
                List.of(new ToTerminal("mirror", false, "exchange", true)), null, null)).value().terminal();
        assertThat(held.get(0).state()).isEqualTo(TerminalItem.State.WAITING);
        assertThat(f.chat.reply(Actor.CLAUDE, n.id(), new Reply("c", List.of(), List.of(), null, null)).outcome()).isEqualTo(Outcome.CONFLICT);
    }

    @Test
    void theProjectChatSendsNothingToATerminalAndUpdateIdEditsInPlace() {
        f.live.beat("odeysys", "laptop", null, "live", false);
        ChatMessage m = send(PROJECT, "watch");
        f.chat.take(Actor.CLAUDE, m.id(), "runner", null);
        ChatMessage first = f.chat.reply(Actor.CLAUDE, m.id(), new Reply("batch 1", List.of(),
                List.of(new ToTerminal("x", true, "addressed", false)), null, null)).value().message();
        assertThat(f.chat.terminal(PROJECT)).isEmpty();
        Result<ChatUseCase.Replied> updated = f.chat.reply(Actor.CLAUDE, m.id(), new Reply("batch 2", List.of(), List.of(), null, first.id()));
        assertThat(updated.value().message().text()).isEqualTo("batch 2");
        assertThat(f.chat.page(PROJECT, null, 50).messages()).filteredOn(x -> x.author() == ChatMessage.Author.CLAUDE).hasSize(1);
    }

    @Test
    void mentionsInAChatAreIndexedAndALiveCallIsKept() {
        ChatMessage m = send(CYCLE, "see @[call:in:abc|POST /pay]");
        assertThat(f.store.mentionsOf(MentionOwner.CHAT, String.valueOf(m.id()))).hasSize(1);
        assertThat(f.mentionedCallsChanged).isPositive();
        assertThat(f.store.mentionedLiveCallIds()).contains("abc");
        f.briefs.cycleRemoved("c-1");
        assertThat(f.chat.message(m.id())).isEmpty();
        assertThat(f.store.mentionedLiveCallIds()).doesNotContain("abc");
    }

    @Test
    void searchMarksFoldedHitsAndHandoverStartsFromTheSummary() {
        holdCycle("chat-a");
        ChatMessage a = takeAndAnswer(send(CYCLE, "payment fails"), "payment is the branch", List.of());
        f.chat.summary(Actor.CLAUDE, CYCLE, "payment: branch filter", a.id());
        send(CYCLE, "payment again?");
        List<ChatUseCase.Hit> hits = f.chat.search(CYCLE, "payment", "all");
        assertThat(hits).hasSize(4);
        assertThat(hits.stream().filter(ChatUseCase.Hit::folded)).hasSize(2);
        ChatUseCase.Handover h = f.chat.handover(CYCLE);
        assertThat(h.summary().text()).isEqualTo("payment: branch filter");
        assertThat(h.after()).extracting(ChatMessage::text).containsExactly("payment again?");
    }

    @SuppressWarnings("unused")
    private static LiveWorkUseCase.Report report(long messageId) {
        return new LiveWorkUseCase.Report("r", "odeysys", 0, "answering", List.of(), null, LiveWork.State.WORKING, null, messageId);
    }

    @SuppressWarnings("unused")
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Test
    void anotherConversationTakingOverIsMarkedInTheChatButAContinuedOneIsNot() {
        java.time.Instant t = java.time.Instant.parse("2026-10-15T10:00:00Z");
        f.chat.putSession(Actor.CLAUDE, CYCLE, "fork-1", "term-1", "laptop", t, t);
        f.chat.putSession(Actor.CLAUDE, CYCLE, "fork-1", "term-1", "laptop", t, t);
        f.chat.putSession(Actor.CLAUDE, CYCLE, "fork-2", "term-1", "laptop", t, t); // re-copied: the runner says so itself
        assertThat(f.chat.page(CYCLE, null, 50).messages()).isEmpty();

        f.chat.putSession(Actor.CLAUDE, CYCLE, "own-1", null, "desktop", t, t);
        assertThat(f.chat.page(CYCLE, null, 50).messages()).singleElement().satisfies(m -> {
            assertThat(m.kind()).isEqualTo(ChatMessage.Kind.SYSTEM);
            assertThat(m.text()).contains("desktop").contains("latest summary");
        });
        assertThat(f.chat.putSession(Actor.USER, CYCLE, "x", null, "h", t, t).isOk()).isFalse();
    }

    @Test
    void aReplyPayloadOver256KbIsRefused() {
        holdCycle("chat-a");
        ChatMessage m = send(CYCLE, "big?");
        f.chat.take(Actor.CLAUDE, m.id(), "chat-a", "c-1");
        com.fasterxml.jackson.databind.node.ObjectNode extra = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode()
                .put("visual", "x".repeat(ChatService.MAX_EXTRA + 1));
        assertThat(f.chat.reply(Actor.CLAUDE, m.id(), new Reply("ok", List.of(), List.of(), extra, null)).outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.chat.reply(Actor.CLAUDE, m.id(), new Reply("ok", List.of(), List.of(), null, null)).isOk()).isTrue();
    }
}
