package com.fathy.alfred.backend.board.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * specs/037: the answers file read by Alfred exactly as the MCP server reads it (mcp-server/test/questions-form.test.ts) -
 * the same files in specs/037-questions-form/fixtures, made by the real form's own script. Only the JSON block counts; a
 * page, a script, a wrong version, a big file and every odd .zip are refused with the same words.
 */
class AnswersFileTest {

    private static final Path FIX = Path.of("../../specs/037-questions-form/fixtures");
    private static final ObjectMapper JSON = new ObjectMapper();

    private static byte[] bytes(String name) throws Exception {
        return Files.readAllBytes(FIX.resolve(name));
    }

    private static String html() throws Exception {
        return Files.readString(FIX.resolve("answers-ok.html"), StandardCharsets.UTF_8);
    }

    /** What the MCP server's reader gave for the same file. */
    private static void sameAsExpected(AnswersFile.Read read) throws Exception {
        assertThat(read.ok()).as(read.problem()).isTrue();
        JsonNode expected = JSON.readTree(FIX.resolve("answers-ok.expected.json").toFile());
        AnswersFile.Parsed p = read.parsed();
        assertThat(p.formId()).isEqualTo(expected.path("formId").asText());
        assertThat(p.answeredBy()).isEqualTo(expected.path("answeredBy").asText());
        assertThat(p.answers()).hasSize(expected.path("answers").size());
        for (int i = 0; i < p.answers().size(); i++) {
            JsonNode e = expected.path("answers").get(i);
            AnswersFile.Answer a = p.answers().get(i);
            List<String> choice = new ArrayList<>();
            e.path("choice").forEach(c -> choice.add(c.asText()));
            assertThat(a.q()).isEqualTo(e.path("q").asText());
            assertThat(a.choice()).isEqualTo(choice);
            assertThat(a.other()).isEqualTo(e.path("other").asBoolean());
            assertThat(a.later()).isEqualTo(e.path("later").asBoolean());
            assertThat(a.note()).isEqualTo(e.path("note").asText());
            assertThat(a.sure()).isEqualTo(e.path("sure").isNull() ? null : e.path("sure").asText());
            if (e.path("follow").isObject()) {
                assertThat(a.follow().q()).isEqualTo(e.path("follow").path("q").asText());
                assertThat(a.follow().choice()).containsExactly(e.path("follow").path("choice").get(0).asText());
            } else {
                assertThat(a.follow()).isNull();
            }
        }
    }

    @Test
    void theFormsOwnAnswersFileReadsAsTheMcpServerReadsIt() throws Exception {
        sameAsExpected(AnswersFile.read("AB62565-answers.html", bytes("answers-ok.html")));
        sameAsExpected(AnswersFile.read("AB62565-answers.zip", bytes("answers-ok.zip")));
        sameAsExpected(AnswersFile.read("x.zip", bytes("answers-macosx.zip")));
        // "</script>" typed in a name cannot end the block
        assertThat(AnswersFile.html(html()).parsed().answeredBy()).isEqualTo("Ahmed </script><b>Ghonim</b>");
    }

    @Test
    void scriptsAroundTheBlockChangeNothingAndNeverRun() throws Exception {
        String wrapped = "<script>throw new Error('ran')</script>" + html() + "<img src=x onerror=alert(1)>";
        sameAsExpected(AnswersFile.html(wrapped));
    }

    @Test
    void refused() throws Exception {
        String ok = html();
        assertThat(AnswersFile.html(ok.replace("\"version\":1", "\"version\":7")).problem()).isEqualTo("Unknown answers file version 7");
        assertThat(AnswersFile.html("<html><body><p>hello</p></body></html>").problem()).isEqualTo(AnswersFile.NOT_ANSWERS);
        assertThat(AnswersFile.html("<script>alert(1)</script>").problem()).isEqualTo(AnswersFile.NOT_ANSWERS);
        assertThat(AnswersFile.html(ok.replace("id=\"alfred-answers\">", "id=\"alfred-answers\">{not json")).problem()).isEqualTo(AnswersFile.NOT_ANSWERS);
        assertThat(AnswersFile.html(ok.replaceFirst("\"formId\":\"qf_[0-9a-f]+\"", "\"formId\":\"x\"")).problem()).isEqualTo(AnswersFile.NOT_ANSWERS);
        assertThat(AnswersFile.html(ok.replace("type=\"application/json\" id=\"alfred-answers\"", "id=\"alfred-answers\"")).problem())
                .as("a block that would run is not the block").isEqualTo(AnswersFile.NOT_ANSWERS);
        byte[] big = new byte[2 * 1024 * 1024 + 1];
        java.util.Arrays.fill(big, (byte) 'A');
        assertThat(AnswersFile.read("a.html", big).problem()).isEqualTo(AnswersFile.TOO_BIG);
    }

    @Test
    void aZipIsOpenedOnlyWhenItHoldsOneAnswersPageAndNeverPastTheLimit() throws Exception {
        assertThat(AnswersFile.read("x.zip", bytes("answers-two-html.zip")).problem()).isEqualTo(AnswersFile.BAD_ZIP);
        assertThat(AnswersFile.read("x.zip", bytes("answers-slip.zip")).problem()).isEqualTo(AnswersFile.BAD_ZIP);
        assertThat(AnswersFile.read("x.zip", bytes("answers-encrypted.zip")).problem()).isEqualTo(AnswersFile.BAD_ZIP);
        assertThat(AnswersFile.read("x.zip", bytes("answers-bomb.zip")).problem()).isEqualTo(AnswersFile.TOO_BIG);
        assertThat(AnswersFile.read("x.zip", "PK\u0003\u0004 not really".getBytes(StandardCharsets.ISO_8859_1)).problem()).isEqualTo(AnswersFile.BAD_ZIP);
    }
}
