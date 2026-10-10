package com.fathy.alfred.backend.board.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The shared vectors in specs/014-task-board/vectors/ - the frontend's mention-syntax.ts, quick-add-parser.ts and
 * acceptance-items.ts run the same files, so the two sides cannot read a line differently without a suite failing.
 */
class ParserVectorsTest {

    static final Path VECTORS = Path.of("..", "..", "specs", "014-task-board", "vectors");

    private static JsonNode read(String name) throws IOException {
        return new ObjectMapper().readTree(Files.readString(VECTORS.resolve(name)));
    }

    @TestFactory
    Stream<DynamicTest> mentionsParseAsTheVectorsSay() throws IOException {
        List<DynamicTest> tests = new ArrayList<>();
        JsonNode file = read("mentions.json");
        for (JsonNode v : file.get("vectors")) {
            tests.add(DynamicTest.dynamicTest(v.get("name").asText(), () -> {
                List<MentionParser.Segment> expected = new ArrayList<>();
                for (JsonNode s : v.get("segments")) {
                    expected.add(s.has("text") ? new MentionParser.Segment(s.get("text").asText(), null)
                            : new MentionParser.Segment(null, ref(s.get("mention"))));
                }
                assertThat(MentionParser.parse(v.get("text").asText())).containsExactlyElementsOf(expected);
            }));
        }
        for (JsonNode v : file.get("slugs")) {
            tests.add(DynamicTest.dynamicTest("slug " + v.get("heading").asText(),
                    () -> assertThat(MentionParser.slug(v.get("heading").asText())).isEqualTo(v.get("slug").asText())));
        }
        for (JsonNode v : file.get("serialize")) {
            tests.add(DynamicTest.dynamicTest("serialize " + v.get("text").asText(),
                    () -> assertThat(MentionParser.serialize(ref(v.get("mention")))).isEqualTo(v.get("text").asText())));
        }
        return tests.stream();
    }

    @TestFactory
    Stream<DynamicTest> quickAddLinesParseAsTheVectorsSay() throws IOException {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode v : read("quick-add.json").get("vectors")) {
            tests.add(DynamicTest.dynamicTest("'" + v.get("line").asText() + "'", () -> {
                QuickAddParser.Parsed parsed = QuickAddParser.parse(v.get("line").asText());
                assertThat(parsed.kind().name()).isEqualTo(v.get("kind").asText());
                assertThat(parsed.title()).isEqualTo(v.get("title").isNull() ? null : v.get("title").asText());
                List<String> flags = new ArrayList<>();
                v.get("flags").forEach(f -> flags.add(f.asText()));
                assertThat(parsed.flags().stream().map(Enum::name).toList()).containsExactlyInAnyOrderElementsOf(flags);
            }));
        }
        return tests.stream();
    }

    @TestFactory
    Stream<DynamicTest> acceptanceItemsAsTheVectorsSay() throws IOException {
        List<DynamicTest> tests = new ArrayList<>();
        JsonNode file = read("acceptance-items.json");
        for (JsonNode v : file.get("vectors")) {
            tests.add(DynamicTest.dynamicTest(v.get("name").asText(), () -> {
                List<String> expected = new ArrayList<>();
                v.get("items").forEach(i -> expected.add(i.asText()));
                assertThat(AcceptanceItems.of(v.get("text").asText()).stream().map(AcceptanceItems.Item::text).toList())
                        .containsExactlyElementsOf(expected);
            }));
        }
        for (JsonNode pair : file.get("keySame")) {
            tests.add(DynamicTest.dynamicTest("same key " + pair.get(0).asText(),
                    () -> assertThat(AcceptanceItems.key(pair.get(0).asText())).isEqualTo(AcceptanceItems.key(pair.get(1).asText()))));
        }
        for (JsonNode pair : file.get("keyDiffer")) {
            tests.add(DynamicTest.dynamicTest("different key " + pair.get(0).asText(),
                    () -> assertThat(AcceptanceItems.key(pair.get(0).asText())).isNotEqualTo(AcceptanceItems.key(pair.get(1).asText()))));
        }
        return tests.stream();
    }

    private static MentionRef ref(JsonNode m) {
        return new MentionRef(MentionType.valueOf(m.get("type").asText().toUpperCase(Locale.ROOT)), m.get("ref").asText(),
                m.get("label").asText());
    }
}
