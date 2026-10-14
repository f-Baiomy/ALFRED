package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.Snippet;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;

/** The board export's visual records (specs/017 R43) read back by the importer: pages with versions, values, shots, files, widgets. */
class ImportVisualsTest {

    private static final String PNG = Base64.getEncoder().encodeToString(new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 0});

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

    private void run(String... lines) throws Exception {
        String text = "{\"format\":\"alfred-board/1\"}\n" + String.join("\n", lines) + "\n";
        f.imports.importBoard("dest", new BufferedReader(new StringReader(text)));
    }

    @Test
    void pagesValuesShotsFilesAndWidgetsComeBackOnTheNewCard() throws Exception {
        // a card already holds number 3 here, so the imported card is renumbered - and everything follows it
        f.add(Actor.USER, "dest", CardKind.TASK, "a", "");
        f.add(Actor.USER, "dest", CardKind.TASK, "b", "");
        f.add(Actor.USER, "dest", CardKind.TASK, "c", "");
        String csv = Base64.getEncoder().encodeToString("a,b\n1,2\n".getBytes(StandardCharsets.UTF_8));
        run("{\"record\":\"card\",\"card\":{\"project\":\"src\",\"number\":3,\"kind\":\"BUG\",\"title\":\"Fares\",\"description\":\"see [📎 rows.csv](/board/files/f-12345678)\","
                        + "\"status\":\"INBOX\",\"scope\":\"NOT_DECIDED\",\"author\":\"USER\",\"createdAt\":\"2026-10-01T10:00:00Z\",\"updatedAt\":\"2026-10-01T10:00:00Z\",\"updatedBy\":\"USER\"},\"links\":[]}",
                "{\"record\":\"activity\",\"cardNumber\":3,\"entry\":{\"id\":77,\"actor\":\"CLAUDE\",\"kind\":\"COMMENT\",\"text\":\"```html live\\n<b>x</b>\\n```\",\"at\":\"2026-10-01T10:00:00Z\"}}",
                "{\"record\":\"page\",\"owner\":\"card\",\"cardNumber\":3,\"id\":\"old-page-1\",\"name\":\"Dash\",\"kind\":\"HTML\",\"info\":\"live\",\"source\":\"<b>v2</b>\","
                        + "\"pinned\":true,\"position\":0,\"author\":\"CLAUDE\",\"version\":2,\"createdAt\":\"2026-10-01T10:00:00Z\",\"updatedAt\":\"2026-10-02T10:00:00Z\",\"updatedBy\":\"CLAUDE\","
                        + "\"versions\":[{\"version\":2,\"name\":\"Dash\",\"info\":\"live\",\"source\":\"<b>v2</b>\",\"author\":\"CLAUDE\",\"at\":\"2026-10-02T10:00:00Z\"},"
                        + "{\"version\":1,\"name\":\"Dash\",\"info\":\"live\",\"source\":\"<b>v1</b>\",\"author\":\"CLAUDE\",\"at\":\"2026-10-01T10:00:00Z\"}]}",
                "{\"record\":\"page\",\"owner\":\"project\",\"id\":\"old-page-2\",\"name\":\"Overview\",\"kind\":\"BLOCK\",\"info\":\"\",\"source\":\"```stats\\nA | 1\\n```\",\"version\":1}",
                "{\"record\":\"state\",\"snippetId\":\"page:old-page-1\",\"key\":\"filter\",\"value\":\"[500]\",\"updatedBy\":\"USER\",\"at\":\"2026-10-02T10:00:00Z\"}",
                "{\"record\":\"state\",\"snippetId\":\"inline:card:#3:77:0\",\"key\":\"seen\",\"value\":\"true\",\"updatedBy\":\"USER\",\"at\":\"2026-10-02T10:00:00Z\"}",
                "{\"record\":\"state\",\"snippetId\":\"inline:card:#3:desc:0\",\"key\":\"bad\",\"value\":\"not json\",\"updatedBy\":\"USER\"}",
                "{\"record\":\"shot\",\"snippetId\":\"page:old-page-1\",\"version\":2,\"png\":\"" + PNG + "\",\"console\":\"ok\",\"at\":\"2026-10-02T10:00:00Z\"}",
                "{\"record\":\"shot\",\"snippetId\":\"page:old-page-1\",\"version\":3,\"png\":\"" + Base64.getEncoder().encodeToString("<svg>".getBytes()) + "\"}",
                "{\"record\":\"file\",\"id\":\"f-12345678\",\"cardNumber\":3,\"name\":\"rows.csv\",\"mime\":\"text/csv\",\"author\":\"USER\",\"data\":\"" + csv + "\"}",
                "{\"record\":\"file\",\"id\":\"f-87654321\",\"cardNumber\":3,\"name\":\"evil.html\",\"data\":\"" + csv + "\"}",
                "{\"record\":\"widget\",\"name\":\"fares\",\"kind\":\"BLOCK\",\"info\":\"\",\"source\":\"```stats\\nA | {{a}}\\n```\",\"author\":\"USER\"}");

        String cardId = f.board.getByNumber("dest", 4).orElseThrow().card().id();
        var pages = f.snippets.pages("card:" + cardId, null).value();
        assertThat(pages).extracting(Snippet::name).containsExactly("Dash");
        Snippet dash = pages.get(0);
        assertThat(dash.pinned()).isTrue();
        assertThat(dash.version()).isEqualTo(2);
        assertThat(f.snippets.page(dash.id(), 1).orElseThrow().source()).isEqualTo("<b>v1</b>");
        assertThat(f.snippets.page(dash.id(), null).orElseThrow().source()).isEqualTo("<b>v2</b>");
        assertThat(f.snippets.pages("project:dest", null).value()).extracting(Snippet::kind).containsExactly(Snippet.Kind.BLOCK);

        assertThat(f.snippets.state(dash.id(), "filter").value().value()).isEqualTo("[500]");
        long comment = f.board.activity(cardId, 0, 100).orElseThrow().entries().stream().filter(e -> e.kind() == ActivityKind.COMMENT)
                .findFirst().orElseThrow().id();
        assertThat(f.snippets.state("inline:card:" + cardId + ":" + comment + ":0", "seen").value().value()).isEqualTo("true");
        assertThat(f.snippets.state("inline:card:" + cardId + ":desc:0").value()).isEmpty();
        assertThat(f.snippets.shot(dash.id()).orElseThrow().version()).isEqualTo(2);

        assertThat(f.files.files(cardId, null).value()).extracting(BoardFile::id).containsExactly("f-12345678");
        assertThat(f.widgets.widget("dest", "fares").orElseThrow().source()).contains("{{a}}");

        // the export side reads the same back
        var visuals = f.snippets.visuals(cardId, null, null).value();
        assertThat(visuals.pages()).hasSize(1);
        assertThat(visuals.pages().get(0).versions()).extracting(v -> v.source()).containsExactly("<b>v2</b>", "<b>v1</b>");
        assertThat(visuals.states()).hasSize(2);
        assertThat(visuals.shots()).hasSize(1);
        assertThat(f.snippets.visuals(null, null, "dest").value().pages()).hasSize(1);
        assertThat(f.snippets.visuals(null, null, null).isOk()).isFalse();
    }
}
