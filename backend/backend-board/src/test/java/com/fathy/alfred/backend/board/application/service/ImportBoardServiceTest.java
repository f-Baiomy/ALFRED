package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ImportBoardUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
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
}
