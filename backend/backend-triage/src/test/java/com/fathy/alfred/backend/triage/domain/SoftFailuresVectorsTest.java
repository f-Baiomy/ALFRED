package com.fathy.alfred.backend.triage.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.triage.domain.model.SoftFailure;
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
 * The shared vectors (specs/007-alfred-mcp-server/soft-failure-vectors.json) - the TypeScript rules in
 * frontend/src/app/shared/utils/soft-failure.ts are checked against the same file by mcp-server's tests, so the two
 * implementations cannot answer differently without one of the suites failing.
 */
class SoftFailuresVectorsTest {

    private static final Path VECTORS = Path.of("..", "..", "specs", "007-alfred-mcp-server", "soft-failure-vectors.json");

    @TestFactory
    Stream<DynamicTest> everyVectorGivesWhatTheTypeScriptGives() throws IOException {
        JsonNode file = new ObjectMapper().readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode v : file.get("vectors")) {
            tests.add(DynamicTest.dynamicTest(v.get("name").asText(), () -> {
                Integer status = v.get("status").isNull() ? null : v.get("status").asInt();
                String error = v.get("error").isNull() ? null : v.get("error").asText();
                String body = v.get("body").asText();

                SoftFailure soft = SoftFailures.softFailureOf(status, error, body);
                JsonNode expected = v.get("softFailure");
                if (expected.isNull()) {
                    assertThat(soft).isNull();
                } else {
                    assertThat(soft).isEqualTo(new SoftFailure(expected.get("kind").asText(),
                            expected.get("code").isNull() ? null : expected.get("code").asText(), expected.get("message").asText()));
                }

                List<String> empty = SoftFailures.emptyResultOf(status, error, body);
                JsonNode expectedKeys = v.get("emptyKeys");
                if (expectedKeys.isNull()) {
                    assertThat(empty).isNull();
                } else {
                    List<String> keys = new ArrayList<>();
                    expectedKeys.forEach(k -> keys.add(k.asText()));
                    assertThat(empty).containsExactlyElementsOf(keys);
                }
            }));
        }
        assertThat(tests).hasSizeGreaterThan(40);
        return tests.stream();
    }

    @Test
    void javascriptNumberText() {
        assertThat(SoftFailures.jsNumber(1.5)).isEqualTo("1.5");
        assertThat(SoftFailures.jsNumber(100)).isEqualTo("100");
        assertThat(SoftFailures.jsNumber(1e-7)).isEqualTo("1e-7");
        assertThat(SoftFailures.jsNumber(0.000001)).isEqualTo("0.000001");
        assertThat(SoftFailures.jsNumber(1e21)).isEqualTo("1e+21");
        assertThat(SoftFailures.jsNumber(123456789012345680000.0)).isEqualTo("123456789012345680000");
        assertThat(SoftFailures.jsNumber(-2.5e-10)).isEqualTo("-2.5e-10");
        assertThat(SoftFailures.jsNumber(-0.0)).isEqualTo("0");
    }
}
