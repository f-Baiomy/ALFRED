package com.fathy.alfred.backend.server.domain.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The shared vectors (specs/012-server-program/fixtures/services-grammar.json): tests/python/test_alfred_settings.py
 * runs the same file against alfred_settings.py, so the supervisor and the backend cannot read one .env line two ways.
 */
class ServicesGrammarTest {

    private static final Path VECTORS = Path.of("..", "..", "specs", "012-server-program", "fixtures", "services-grammar.json");

    @TestFactory
    Stream<DynamicTest> everyProjectVectorParsesLikeThePython() throws IOException {
        JsonNode file = new ObjectMapper().readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode v : file.get("services")) {
            tests.add(DynamicTest.dynamicTest("services: '" + v.get("input").asText() + "'", () -> {
                List<Project> parsed = ServicesGrammar.parseProjects(v.get("input").asText());
                List<Project> expected = new ArrayList<>();
                for (JsonNode e : v.get("entries")) {
                    expected.add(new Project(e.get("name").asText(), e.get("listenPort").asInt(), e.get("upstreamPort").asInt(),
                            e.get("outboundHost").isNull() ? null : e.get("outboundHost").asText(),
                            e.get("outboundPort").isNull() ? null : e.get("outboundPort").asInt()));
                }
                assertThat(parsed).containsExactlyElementsOf(expected);
            }));
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(8);
        return tests.stream();
    }

    @TestFactory
    Stream<DynamicTest> everyFolderVectorParsesLikeThePython() throws IOException {
        JsonNode file = new ObjectMapper().readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode v : file.get("watchDirs")) {
            tests.add(DynamicTest.dynamicTest("watchDirs: '" + v.get("input").asText() + "'", () -> {
                List<WatchedFolder> parsed = ServicesGrammar.parseFolders(v.get("input").asText(), warning -> { });
                List<WatchedFolder> expected = new ArrayList<>();
                for (JsonNode f : v.get("folders")) {
                    expected.add(new WatchedFolder(f.get("name").asText(), f.get("path").asText()));
                }
                assertThat(parsed).containsExactlyElementsOf(expected);
            }));
        }
        return tests.stream();
    }

    @Test
    void serializingParsedProjectsGivesTheSameProjectsBack() {
        String value = "a:9001:8080,b:9002:8081:card.local:8443";
        assertThat(ServicesGrammar.serializeProjects(ServicesGrammar.parseProjects(value))).isEqualTo(value);
        assertThat(ServicesGrammar.parseProjects("c:9003:8085:wallet.local").get(0).serialize())
                .isEqualTo("c:9003:8085:wallet.local:443");
    }

    @Test
    void windowsFolderPathsKeepTheirDriveLetter() {
        assertThat(ServicesGrammar.serializeFolders(ServicesGrammar.parseFolders("app:C:\\logs\\app", w -> { })))
                .isEqualTo("app:C:\\logs\\app");
    }
}
