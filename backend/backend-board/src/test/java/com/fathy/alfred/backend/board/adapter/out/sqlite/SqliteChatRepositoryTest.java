package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fathy.alfred.backend.board.domain.model.ChatChange;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatMessage.Author;
import com.fathy.alfred.backend.board.domain.model.ChatMessage.Kind;
import com.fathy.alfred.backend.board.domain.model.ChatMessage.State;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSession;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatSummary;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteChatRepositoryTest {

    private static final ChatKey CYCLE = new ChatKey("odeysys", "c-1");
    private static final ChatKey OTHER = new ChatKey("odeysys", "c-2");
    private static final ChatKey PROJECT = new ChatKey("odeysys", "");

    @TempDir
    Path dir;

    private final ObjectMapper json = JsonMapper.builder().findAndAddModules().build();
    private SqliteBoardRepository board;
    private SqliteChatRepository chats;

    @BeforeEach
    void setUp() {
        board = new SqliteBoardRepository(json, dir.resolve("board.db").toString());
        board.init();
        chats = new SqliteChatRepository(board, json);
        chats.init();
    }

    @AfterEach
    void tearDown() {
        board.close();
    }

    private ChatMessage user(ChatKey chat, String text) {
        return chats.insert(new ChatMessage(0, chat, null, Author.USER, Kind.TEXT, text, State.WAITING, false, false, "typed", List.of(), null,
                null, Map.of(), null, null, null, false, Instant.now(), null));
    }

    private ChatMessage claude(ChatKey chat, String text, String extra, Long replyTo) throws Exception {
        return chats.insert(new ChatMessage(0, chat, null, Author.CLAUDE, Kind.TEXT, text, State.DONE, false, false, null, List.of(), null,
                extra == null ? null : json.readTree(extra), Map.of(), null, replyTo, null, false, Instant.now(), null));
    }

    @Test
    void aMessageRoundTripsEveryField() throws Exception {
        ChatMessage stored = chats.insert(new ChatMessage(0, CYCLE, null, Author.USER, Kind.TEXT, "why 500 on @[call:abc|POST /pay]?",
                State.WAITING, true, false, "ask-item", List.of("card:12", "call:abc"), "quoted part", json.readTree("{\"a\":1}"),
                Map.of("👍", 2), null, null, "project", false, Instant.parse("2026-10-15T10:00:00Z"), null));

        ChatMessage read = chats.find(stored.id()).orElseThrow();

        assertThat(read.id()).isPositive();
        assertThat(read.chat()).isEqualTo(CYCLE);
        assertThat(read.text()).isEqualTo("why 500 on @[call:abc|POST /pay]?");
        assertThat(read.urgent()).isTrue();
        assertThat(read.origin()).isEqualTo("ask-item");
        assertThat(read.context()).containsExactly("card:12", "call:abc");
        assertThat(read.quote()).isEqualTo("quoted part");
        assertThat(read.extra().path("a").asInt()).isEqualTo(1);
        assertThat(read.reactions()).containsEntry("👍", 2);
        assertThat(read.bridgeFrom()).isEqualTo("project");
        assertThat(read.createdAt()).isEqualTo(Instant.parse("2026-10-15T10:00:00Z"));
        assertThat(read.editedAt()).isNull();
    }

    @Test
    void aTakeHasExactlyOneWinner() {
        ChatMessage m = user(CYCLE, "hi");

        assertThat(chats.changeState(m.id(), State.WAITING, State.TAKEN)).isTrue();
        assertThat(chats.changeState(m.id(), State.WAITING, State.TAKEN)).isFalse();
        assertThat(chats.changeState(m.id(), State.WAITING, State.CANCELLED)).isFalse();
        assertThat(chats.find(m.id()).orElseThrow().state()).isEqualTo(State.TAKEN);
    }

    @Test
    void pagesAreWindowedOldestFirstAndTheProjectChatShowsBridgedQuestions() {
        for (int i = 0; i < 5; i++) {
            user(CYCLE, "m" + i);
        }
        ChatMessage bridged = chats.insert(new ChatMessage(0, OTHER, null, Author.USER, Kind.TEXT, "asked from the project", State.WAITING,
                false, false, "bridge", List.of(), null, null, Map.of(), null, null, "project", false, Instant.now(), null));
        user(PROJECT, "project question");

        List<ChatMessage> newest = chats.page(CYCLE, null, 2);
        assertThat(newest).extracting(ChatMessage::text).containsExactly("m3", "m4");
        List<ChatMessage> older = chats.page(CYCLE, newest.get(0).id(), 10);
        assertThat(older).extracting(ChatMessage::text).containsExactly("m0", "m1", "m2");

        assertThat(chats.page(PROJECT, null, 10)).extracting(ChatMessage::text).containsExactly("asked from the project", "project question");
        assertThat(chats.page(OTHER, null, 10)).extracting(ChatMessage::id).containsExactly(bridged.id());
    }

    @Test
    void waitingPutsUrgentFirstAndChangesListOnlyWaitingMessages() {
        ChatMessage first = user(CYCLE, "first");
        ChatMessage urgent = chats.insert(new ChatMessage(0, CYCLE, null, Author.USER, Kind.TEXT, "now", State.WAITING, true, false, "typed",
                List.of(), null, null, Map.of(), null, null, null, false, Instant.now(), null));
        ChatMessage answered = user(CYCLE, "done");
        chats.changeState(answered.id(), State.WAITING, State.ANSWERED);
        user(new ChatKey("other-project", "c-9"), "elsewhere");

        assertThat(chats.waiting(CYCLE)).extracting(ChatMessage::id).containsExactly(urgent.id(), first.id());

        List<ChatChange> changes = chats.changesAfter(0, "odeysys", null, 50);
        assertThat(changes).extracting(ChatChange::messageId).containsExactly(first.id(), urgent.id());
        assertThat(changes.get(1).urgent()).isTrue();
        assertThat(changes.get(0).scope()).isEqualTo("c-1");
        assertThat(chats.changesAfter(first.id(), "odeysys", "c-1", 50)).extracting(ChatChange::messageId).containsExactly(urgent.id());
        assertThat(chats.changesAfter(0, null, null, 50)).hasSize(3);
    }

    @Test
    void summariesCountWaitingAndWhatWaitsOnTheUser() throws Exception {
        ChatMessage q = user(CYCLE, "what now?");
        ChatMessage a = claude(CYCLE, "Two options: @[card:7|#7 login] or skip.",
                "{\"questions\":[{\"id\":\"q1\",\"text\":\"which?\"},{\"id\":\"q2\",\"answer\":\"a\"}],"
                        + "\"proposals\":[{\"id\":\"p1\"},{\"id\":\"p2\",\"state\":\"applied\"}],\"consent\":{\"kind\":\"resend\"}}", q.id());
        user(CYCLE, "and this");
        user(PROJECT, "p");

        List<ChatSummary> rows = chats.summaries("odeysys");
        ChatSummary cycle = rows.stream().filter(ChatSummary::cycle).findFirst().orElseThrow();
        assertThat(cycle.scope()).isEqualTo("c-1");
        assertThat(cycle.waiting()).isEqualTo(2);
        assertThat(cycle.questions()).isEqualTo(1);
        assertThat(cycle.proposals()).isEqualTo(1);
        assertThat(cycle.confirms()).isEqualTo(1);
        assertThat(cycle.needsYou()).isTrue();
        assertThat(cycle.lastPreview()).isEqualTo("and this");
        assertThat(rows.stream().filter(r -> !r.cycle()).findFirst().orElseThrow().scope()).isEqualTo("project");

        // Answering the question and the consent, and asking the answer again, clears what waited on the user.
        ChatMessage stored = chats.find(a.id()).orElseThrow();
        chats.update(new ChatMessage(stored.id(), stored.chat(), null, stored.author(), stored.kind(), stored.text(), stored.state(), false,
                false, null, List.of(), null, stored.extra(), Map.of(), null, stored.replyTo(), null, true, stored.createdAt(), Instant.now()));
        ChatSummary after = chats.summaries("odeysys").stream().filter(ChatSummary::cycle).findFirst().orElseThrow();
        assertThat(after.needsYou()).isFalse();
    }

    @Test
    void thePreviewShowsMentionsByTheirLabelOnOneLine() {
        assertThat(SqliteChatRepository.preview("see @[call:abc-1|POST /pay 500]\nand  more")).isEqualTo("see POST /pay 500 and more");
        assertThat(SqliteChatRepository.preview("x".repeat(500))).hasSize(ChatSummary.PREVIEW);
    }

    @Test
    void searchFiltersByTextAndKind() throws Exception {
        user(CYCLE, "The Payment fails");
        claude(CYCLE, "payment is fixed", null, null);
        user(CYCLE, "100%_done");

        assertThat(chats.search(CYCLE, "PAYMENT", "", 10)).hasSize(2);
        assertThat(chats.search(CYCLE, "payment", "mine", 10)).hasSize(1);
        assertThat(chats.search(CYCLE, "%_", "", 10)).hasSize(1);
        assertThat(chats.search(OTHER, "payment", "", 10)).isEmpty();
    }

    @Test
    void settingsDefaultUntilStoredAndSessionsUpsert() {
        assertThat(chats.settings(CYCLE)).isEqualTo(ChatSettings.defaults(CYCLE));
        chats.putSettings(new ChatSettings(CYCLE, 50, 45, true));
        chats.putSettings(new ChatSettings(CYCLE, 0, 30, false));
        assertThat(chats.settings(CYCLE)).isEqualTo(new ChatSettings(CYCLE, 0, 30, false));

        assertThat(chats.session(CYCLE)).isEmpty();
        Instant t = Instant.parse("2026-10-15T10:00:00Z");
        chats.putSession(new ChatSession(CYCLE, "fork-1", "term-1", "pc", t, t, null));
        chats.putSession(new ChatSession(CYCLE, "fork-1", "term-1", "pc", t, t, t.plusSeconds(60)));
        ChatSession s = chats.session(CYCLE).orElseThrow();
        assertThat(s.terminalMovedOn()).isTrue();
        assertThat(s.forkedFrom()).isEqualTo("term-1");
    }

    @Test
    void summariesCountOnlyTalkAfterTheLastSummary() throws Exception {
        user(CYCLE, "a");
        ChatMessage covered = claude(CYCLE, "b", null, null);
        chats.insert(new ChatMessage(0, CYCLE, null, Author.CLAUDE, Kind.SUMMARY, "summary", State.DONE, false, false, null, List.of(), null,
                null, Map.of(), covered.id(), null, null, false, Instant.now(), null));
        user(CYCLE, "c");

        ChatMessage summary = chats.lastSummary(CYCLE).orElseThrow();
        assertThat(summary.coversTo()).isEqualTo(covered.id());
        assertThat(chats.countAfter(CYCLE, summary.id())).isEqualTo(1);
        assertThat(chats.after(CYCLE, covered.id(), 10)).extracting(ChatMessage::text).containsExactly("summary", "c");
    }

    @Test
    void terminalItemsCannotLeaveReadOrUndone() {
        ChatMessage m = user(CYCLE, "q");
        TerminalItem one = chats.insertTerminalItem(new TerminalItem(0, CYCLE, m.id(), false, true, "Q and A", "exchange",
                TerminalItem.State.SENT, null, null, null));
        TerminalItem two = chats.insertTerminalItem(new TerminalItem(0, CYCLE, m.id(), true, false, "contradicts #7", "contradicts",
                TerminalItem.State.SENT, null, null, null));

        chats.setTerminalState(List.of(one.id(), two.id()), TerminalItem.State.DELIVERED);
        chats.setTerminalState(List.of(two.id()), TerminalItem.State.UNDONE);
        chats.setTerminalState(List.of(one.id()), TerminalItem.State.READ);
        chats.setTerminalState(List.of(one.id(), two.id()), TerminalItem.State.DELIVERED);

        TerminalItem readOne = chats.findTerminalItem(one.id()).orElseThrow();
        assertThat(readOne.state()).isEqualTo(TerminalItem.State.READ);
        assertThat(readOne.deliveredAt()).isNotNull();
        assertThat(readOne.readAt()).isNotNull();
        assertThat(readOne.canUndo()).isFalse();
        assertThat(chats.findTerminalItem(two.id()).orElseThrow().state()).isEqualTo(TerminalItem.State.UNDONE);
        assertThat(chats.terminalItems(CYCLE, true, 10)).isEmpty();
        assertThat(chats.terminalItems(CYCLE, false, 10)).extracting(TerminalItem::id).containsExactly(one.id(), two.id());
        assertThat(chats.terminalOf(List.of(m.id()))).extracting(TerminalItem::id).containsExactly(one.id(), two.id());
        assertThat(chats.terminalOf(List.of())).isEmpty();
    }

    @Test
    void recordsUndoOnce() {
        ChatMessage m = user(CYCLE, "q");
        ChatRecord r = chats.insertRecord(new ChatRecord(0, m.id(), ChatRecord.Kind.DECISION, "brief", "recorded the decision in the brief",
                "{\"before\":\"\"}", null, null));

        chats.markRecordUndone(r.id());
        Instant first = chats.findRecord(r.id()).orElseThrow().undoneAt();
        chats.markRecordUndone(r.id());

        assertThat(first).isNotNull();
        assertThat(chats.findRecord(r.id()).orElseThrow().undoneAt()).isEqualTo(first);
        assertThat(chats.recordsOf(List.of(m.id()))).hasSize(1);
        assertThat(chats.recordsOf(List.of())).isEmpty();
    }

    @Test
    void removingACycleTakesItsWholeChatAndItsMentionsOnly() {
        ChatMessage gone = user(CYCLE, "@[call:abc|GET /x]");
        ChatMessage kept = user(OTHER, "@[call:def|GET /y]");
        board.replaceMentions(MentionOwner.CHAT, String.valueOf(gone.id()), null, List.of(new MentionRef(MentionType.CALL, "abc", "GET /x")));
        board.replaceMentions(MentionOwner.CHAT, String.valueOf(kept.id()), null, List.of(new MentionRef(MentionType.CALL, "def", "GET /y")));
        chats.insertRecord(new ChatRecord(0, gone.id(), ChatRecord.Kind.CARD, "card-1", "added #3 to the Inbox", null, null, null));
        chats.insertTerminalItem(new TerminalItem(0, CYCLE, gone.id(), false, true, "x", "exchange", TerminalItem.State.SENT, null, null, null));
        chats.putSettings(new ChatSettings(CYCLE, 50, 30, true));
        chats.putSession(new ChatSession(CYCLE, "fork", null, "pc", null, null, null));
        chats.insertWatch(new ChatWatch(0, CYCLE, ChatWatch.Kind.STATUS, "5xx", "a 5xx shows up", gone.id(), null));
        ChatWatch otherWatch = chats.insertWatch(new ChatWatch(0, OTHER, ChatWatch.Kind.ITEM_PASSES, "ac3", "AC3 passes", kept.id(), null));

        chats.cycleRemoved("c-1");

        assertThat(chats.find(gone.id())).isEmpty();
        assertThat(chats.find(kept.id())).isPresent();
        assertThat(chats.recordsOf(List.of(gone.id()))).isEmpty();
        assertThat(chats.terminalItems(CYCLE, false, 10)).isEmpty();
        assertThat(chats.settings(CYCLE)).isEqualTo(ChatSettings.defaults(CYCLE));
        assertThat(chats.session(CYCLE)).isEmpty();
        assertThat(board.mentionsOf(MentionOwner.CHAT, String.valueOf(gone.id()))).isEmpty();
        assertThat(board.mentionsOf(MentionOwner.CHAT, String.valueOf(kept.id()))).hasSize(1);
        assertThat(chats.watches("odeysys")).extracting(ChatWatch::id).containsExactly(otherWatch.id());
        assertThat(chats.deleteWatch(otherWatch.id())).isTrue();
        assertThat(chats.watches("odeysys")).isEmpty();
    }

    @Test
    void aLiveCallMentionedInAChatIsKeptOutOfTheStorageLimitsUntilItsCycleGoes() {
        // FR-013: the storage limits read mentionedLiveCallIds (CommentedCallsKept.BoardMentions) - every owner counts.
        ChatMessage m = user(CYCLE, "@[call:in:abc|POST /pay]");
        board.replaceMentions(MentionOwner.CHAT, String.valueOf(m.id()), null, List.of(new MentionRef(MentionType.CALL, "in:abc", "POST /pay")));

        assertThat(board.mentionedLiveCallIds()).containsExactly("abc");

        chats.cycleRemoved("c-1");
        assertThat(board.mentionedLiveCallIds()).isEmpty();
    }

    @Test
    void exportPagesEveryChatInOrder() {
        ChatMessage a = user(CYCLE, "a");
        user(PROJECT, "b");
        user(OTHER, "c");
        user(new ChatKey("elsewhere", ""), "d");

        assertThat(chats.exportPage("odeysys", null, 0, 2)).extracting(ChatMessage::text).containsExactly("a", "b");
        assertThat(chats.exportPage("odeysys", null, a.id() + 1, 10)).extracting(ChatMessage::text).containsExactly("c");
        assertThat(chats.exportPage("odeysys", "c-2", 0, 10)).extracting(ChatMessage::text).containsExactly("c");
        assertThat(chats.exportPage("odeysys", "", 0, 10)).extracting(ChatMessage::text).containsExactly("b");
    }
}
