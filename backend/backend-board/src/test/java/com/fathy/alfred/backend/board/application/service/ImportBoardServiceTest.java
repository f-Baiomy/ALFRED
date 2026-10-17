package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.ImportBoardUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.StringReader;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The importer's side of the alfred-board/1 format. The frontend's board-json.spec.ts builds its fixtures with the real
 * exporter and round-trips them; these lines follow that exporter's record shapes.
 */
class ImportBoardServiceTest {

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

    private static String card(int number, String title, String description) {
        return "{\"record\":\"card\",\"card\":{\"project\":\"src\",\"number\":" + number + ",\"kind\":\"BUG\",\"title\":\"" + title
                + "\",\"description\":\"" + description + "\",\"status\":\"CLOSED\",\"resolution\":\"FINE\",\"reason\":\"expected\","
                + "\"flags\":[\"URGENT\"],\"scope\":\"IN_SCOPE\",\"author\":\"CLAUDE\",\"cycleId\":\"c-1\",\"cycleDeleted\":false,"
                + "\"signature\":null,\"createdAt\":\"2026-10-01T10:00:00Z\",\"updatedAt\":\"2026-10-02T10:00:00Z\",\"updatedBy\":\"USER\"},"
                + "\"links\":[{\"type\":\"cycle\",\"ref\":\"c-1\",\"label\":\"order-flow\"}]}";
    }

    private ImportBoardUseCase.ImportResult run(String... lines) throws Exception {
        String text = "{\"format\":\"alfred-board/1\"}\n" + String.join("\n", lines) + "\n";
        return f.imports.importBoard("dest", new BufferedReader(new StringReader(text)));
    }

    @Test
    void repliesComeBackInTheirThreads() throws Exception {
        run(card(1, "Q", ""),
                "{\"record\":\"activity\",\"cardNumber\":1,\"entry\":{\"id\":40,\"actor\":\"CLAUDE\",\"kind\":\"COMMENT\","
                        + "\"text\":\"**Question** which?\",\"at\":\"2026-10-01T10:00:00Z\"}}",
                "{\"record\":\"activity\",\"cardNumber\":1,\"entry\":{\"id\":41,\"actor\":\"USER\",\"kind\":\"COMMENT\","
                        + "\"text\":\"this one\",\"at\":\"2026-10-01T10:01:00Z\",\"replyTo\":40}}");

        String id = f.board.getByNumber("dest", 1).orElseThrow().card().id();
        var entries = f.board.activity(id, 0, 100).orElseThrow().entries().stream()
                .filter(e -> e.kind() == com.fathy.alfred.backend.board.domain.model.ActivityKind.COMMENT).toList();
        assertThat(entries.get(1).replyTo()).isEqualTo(entries.get(0).id());
    }

    @Test
    void cardsComeBackWithTheirFieldsHistoryAndLinks() throws Exception {
        ImportBoardUseCase.ImportResult result = run(card(1, "Discount", "see @[call:in:a1|POST]"),
                "{\"record\":\"activity\",\"cardNumber\":1,\"entry\":{\"actor\":\"CLAUDE\",\"kind\":\"COMMENT\",\"text\":\"**Did** x\","
                        + "\"oldValue\":null,\"newValue\":null,\"at\":\"2026-10-01T11:00:00Z\"}}",
                "{\"record\":\"brief\",\"cycleId\":\"c-1\",\"text\":\"what it is for\",\"updatedAt\":\"2026-10-01T10:00:00Z\"}",
                "{\"record\":\"spec\",\"cycleId\":\"c-1\",\"name\":\"spec.md\",\"content\":\"## Acceptance\\n- a\",\"uploadedAt\":\"2026-10-01T10:00:00Z\"}");

        assertThat(result.cards()).isEqualTo(1);
        assertThat(result.renumbered()).isEmpty();
        CardDetail card = f.board.getByNumber("dest", 1).orElseThrow();
        assertThat(card.card().resolution().name()).isEqualTo("FINE");
        assertThat(card.card().reason()).isEqualTo("expected");
        assertThat(card.card().author()).isEqualTo(Actor.CLAUDE);
        assertThat(card.links()).extracting(l -> l.ref()).containsExactly("in:a1", "c-1");
        List<ActivityEntry> history = f.board.activity(card.card().id(), 0, 100).orElseThrow().entries();
        assertThat(history).extracting(ActivityEntry::kind).containsExactly(ActivityKind.IMPORTED, ActivityKind.COMMENT);
        assertThat(history.get(1).actor()).isEqualTo(Actor.CLAUDE);
        assertThat(f.briefs.brief("c-1").text()).isEqualTo("what it is for");
        assertThat(f.briefs.spec("c-1", "spec.md").orElseThrow().content()).isEqualTo("## Acceptance\n- a");
        assertThat(f.board.mentionedLiveCallIds()).containsExactly("a1");
    }

    @Test
    void aLinkTypeThisAlfredDoesNotKnowIsSkippedNotAFailedImport() throws Exception {
        // specs/022 R14: a newer Alfred's export may carry link types (chat, or whatever comes next) this one never heard of.
        String newer = card(1, "From a newer Alfred", "").replace("\"links\":[",
                "\"links\":[{\"type\":\"hologram\",\"ref\":\"h-1\",\"label\":\"x\"},{\"type\":\"chat\",\"ref\":\"12\",\"label\":\"msg\"},");

        ImportBoardUseCase.ImportResult result = run(newer);

        assertThat(result.cards()).isEqualTo(1);
        assertThat(f.board.getByNumber("dest", 1).orElseThrow().links()).extracting(l -> l.ref()).containsExactly("12", "c-1");
    }

    @Test
    void clashingNumbersAreRenumberedAndCardMentionsFollow() throws Exception {
        f.add(Actor.USER, "dest", CardKind.TASK, "already #1", "");

        ImportBoardUseCase.ImportResult result = run(card(1, "first", ""), card(2, "second", "dup of @[card:src#1|first]"));

        assertThat(result.renumbered()).containsExactly(new ImportBoardUseCase.Renumbered(1, 3));
        assertThat(f.board.getByNumber("dest", 3).orElseThrow().card().title()).isEqualTo("first");
        assertThat(f.board.getByNumber("dest", 2).orElseThrow().card().description()).isEqualTo("dup of @[card:dest#3|first]");
    }

    @Test
    void rewriteLeavesOtherProjectsCardsAlone() {
        assertThat(ImportBoardService.rewrite("@[card:other#1|x] @[card:src#1|y]", "src", "dest", Map.of("1", 9)))
                .isEqualTo("@[card:other#1|x] @[card:dest#9|y]");
    }

    @Test
    void aFileThatIsNotABoardExportIsRefused() {
        assertThatThrownBy(() -> f.imports.importBoard("d", new BufferedReader(new StringReader("{\"format\":\"alfred-calls/3\"}\n"))))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // ------------------------------------------------------------------------------------------- board chats (specs/022)

    private List<String> exportChats(String project) {
        List<String> lines = new java.util.ArrayList<>();
        long after = 0;
        while (true) {
            ChatUseCase.ExportPage page = f.chat.exportChats(project, null, after, 2);
            page.lines().forEach(l -> lines.add(l.toString()));
            if (!page.more()) {
                return lines;
            }
            after = page.next();
        }
    }

    private ChatMessage post(ChatKey chat, String text, Long parentId) {
        ChatUseCase.Result<ChatMessage> r = f.chat.post(Actor.USER, chat, new ChatUseCase.Post(text, parentId, List.of(), null, false, null, List.of()));
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value();
    }

    @Test
    void chatsComeBackWithThreadsAnswersRecordsAndItems() throws Exception {
        f.cycleNames.put("c-1", "order-flow");
        ChatKey cycle = new ChatKey("src", "c-1");
        f.live.chatBeat("src", "c-1", "chat-a", "laptop", "C:/work", "live", true, false);
        ChatMessage q = post(cycle, "why 500?", null);
        post(cycle, "and the retry?", q.id());
        assertThat(f.chat.take(Actor.CLAUDE, q.id(), "chat-a", "c-1").isOk()).isTrue();
        var replied = f.chat.reply(Actor.CLAUDE, q.id(), new ChatUseCase.Reply("The null branch.",
                List.of(new ChatUseCase.RecordRequest(ChatRecord.Kind.DECISION, "Keep the branch filter", null, null, null)),
                List.of(new ChatUseCase.ToTerminal("contradicts your step", true, "contradicts", false)), null, null));
        assertThat(replied.isOk()).as(replied.message()).isTrue();
        post(new ChatKey("src", ""), "still waiting", null);

        run(exportChats("src").toArray(String[]::new));

        ChatUseCase.Page page = f.chat.page(new ChatKey("dest", "c-1"), null, 100);
        List<ChatMessage> msgs = page.messages();
        ChatMessage q2 = msgs.stream().filter(m -> m.text().equals("why 500?")).findFirst().orElseThrow();
        ChatMessage child = msgs.stream().filter(m -> m.text().equals("and the retry?")).findFirst().orElseThrow();
        ChatMessage answer = msgs.stream().filter(m -> m.text().equals("The null branch.")).findFirst().orElseThrow();
        assertThat(q2.state()).isEqualTo(ChatMessage.State.ANSWERED);
        assertThat(child.parentId()).isEqualTo(q2.id());
        assertThat(child.state()).as("nobody here asked for it").isEqualTo(ChatMessage.State.STOPPED);
        assertThat(answer.replyTo()).isEqualTo(q2.id());
        assertThat(answer.author()).isEqualTo(ChatMessage.Author.CLAUDE);

        List<ChatRecord> records = page.records().get(answer.id());
        assertThat(records).extracting(ChatRecord::kind).containsExactly(ChatRecord.Kind.DECISION);
        assertThat(f.chat.undoRecord(Actor.USER, records.get(0).id()).isOk()).as("its brief belongs to the other board").isFalse();
        assertThat(f.chatStore.terminalItems(new ChatKey("dest", "c-1"), false, 10)).singleElement()
                .satisfies(t -> assertThat(t.state()).isEqualTo(TerminalItem.State.READ));
        assertThat(f.chatStore.terminalItems(new ChatKey("dest", "c-1"), true, 10)).as("never sent to this terminal").isEmpty();

        assertThat(f.chat.page(new ChatKey("dest", ""), null, 100).messages()).extracting(ChatMessage::text, ChatMessage::state)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("still waiting", ChatMessage.State.STOPPED));
        assertThat(f.chat.page(new ChatKey("src", "c-1"), null, 100).messages()).as("the source is untouched").hasSize(3);
    }

    @Test
    void aCycleChatWhoseCycleIsNotHereLandsInTheProjectChatMarked() throws Exception {
        f.cycleNames.put("c-9", "checkout");
        post(new ChatKey("src", "c-9"), "is the total right?", null);
        List<String> lines = exportChats("src");
        f.cycleNames.clear();

        run(lines.toArray(String[]::new));

        assertThat(f.chat.page(new ChatKey("dest", "c-9"), null, 100).messages()).isEmpty();
        assertThat(f.chat.page(new ChatKey("dest", ""), null, 100).messages()).extracting(ChatMessage::text)
                .containsExactly("*[from cycle checkout]* is the total right?");
    }

    @Test
    void anExportWithoutChatsLeavesTheChatsAlone() throws Exception {
        post(new ChatKey("dest", ""), "mine", null);
        run(card(1, "Q", ""));
        assertThat(f.chat.page(new ChatKey("dest", ""), null, 100).messages()).extracting(ChatMessage::text).containsExactly("mine");
    }

    /** specs/027 T081: boards, their cycles and related boards, card homes and related cycles come back; the default stays the default. */
    @Test
    void boardsTheirRelationsAndCardHomesComeBack() throws Exception {
        String home = card(1, "Refund", "").replace("\"updatedBy\":\"USER\"}", "\"updatedBy\":\"USER\",\"boardId\":\"b-refund\"}");
        String onDefault = card(2, "Other", "").replace("\"updatedBy\":\"USER\"}", "\"updatedBy\":\"USER\",\"boardId\":\"default:src\"}");
        run(home, onDefault,
                "{\"record\":\"board\",\"board\":{\"id\":\"default:src\",\"name\":\"src\",\"isDefault\":true,\"state\":\"OPEN\"}}",
                "{\"record\":\"board\",\"board\":{\"id\":\"b-refund\",\"name\":\"Refund flow\",\"isDefault\":false,\"state\":\"OPEN\","
                        + "\"createdAt\":\"2026-10-01T10:00:00Z\"}}",
                "{\"record\":\"board\",\"board\":{\"id\":\"b-sprint\",\"name\":\"Sprint\",\"isDefault\":false,\"state\":\"DONE\"}}",
                "{\"record\":\"board-cycle\",\"boardId\":\"b-refund\",\"cycleId\":\"c-1\"}",
                "{\"record\":\"board-board\",\"boardId\":\"b-refund\",\"otherId\":\"b-sprint\"}",
                "{\"record\":\"card-cycle\",\"cardNumber\":1,\"cycleId\":\"c-9\"}",
                "{\"record\":\"workitem-snapshot\",\"boardId\":\"b-refund\",\"conn\":\"c1\",\"extId\":\"7\",\"snapshot\":{}}",
                "{\"record\":\"brief\",\"cycleId\":\"b-refund\",\"text\":\"The refund task\",\"updatedAt\":\"2026-10-01T10:00:00Z\"}");

        var refund = f.boardModel.board("b-refund").orElseThrow();
        assertThat(refund.project()).isEqualTo("dest");
        assertThat(refund.name()).isEqualTo("Refund flow");
        assertThat(f.boardModel.board("b-sprint").orElseThrow().state()).isEqualTo(com.fathy.alfred.backend.board.domain.model.BoardState.DONE);
        assertThat(f.boardModel.cyclesOf("b-refund")).containsExactly("c-1");
        assertThat(f.boardModel.relatedBoards("b-refund")).containsExactly("b-sprint");
        String id1 = f.board.getByNumber("dest", 1).orElseThrow().card().id();
        String id2 = f.board.getByNumber("dest", 2).orElseThrow().card().id();
        assertThat(f.boardModel.cardCounts(java.util.List.of("b-refund"))).containsEntry("b-refund", 1);
        assertThat(f.boardModel.cardCycles(id1)).containsExactly("c-9");
        assertThat(f.boardModel.cardCycles(id2)).isEmpty();
        assertThat(f.briefs.brief("b-refund").text()).isEqualTo("The refund task");
    }

    @Test
    void aBoardIdOfAnotherProjectHereIsRenamedAndItsBriefFollows() throws Exception {
        f.boardModel.putBoard(new com.fathy.alfred.backend.board.domain.model.Board("b-x", "elsewhere", "Theirs", false,
                com.fathy.alfred.backend.board.domain.model.BoardState.OPEN, null, java.time.Instant.now(), java.time.Instant.now(),
                com.fathy.alfred.backend.board.domain.model.Actor.USER));
        run(card(1, "A", "").replace("\"cycleId\":\"c-1\"", "\"cycleId\":\"b-x\""),
                "{\"record\":\"board\",\"board\":{\"id\":\"b-x\",\"name\":\"Mine\",\"isDefault\":false,\"state\":\"OPEN\"}}",
                "{\"record\":\"brief\",\"cycleId\":\"b-x\",\"text\":\"mine\",\"updatedAt\":\"2026-10-01T10:00:00Z\"}");
        assertThat(f.boardModel.board("b-x").orElseThrow().name()).isEqualTo("Theirs");
        var mine = f.boardModel.boards("dest", java.util.Set.of(com.fathy.alfred.backend.board.domain.model.BoardState.OPEN), null, 50).stream()
                .filter(b -> b.name().equals("Mine")).findFirst().orElseThrow();
        assertThat(f.briefs.brief(mine.id()).text()).isEqualTo("mine");
        assertThat(f.board.getByNumber("dest", 1).orElseThrow().card().cycleId()).as("its card follows the new key").isEqualTo(mine.id());
    }
}
