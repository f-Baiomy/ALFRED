package com.fathy.alfred.backend.resend.domain.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Runs {@code specs/002-power-features/dynamic-token-vectors.json} against {@link DynamicTokens},
 * the same corpus the proxy (Python) and the frontend preview ({@code dynamic-tokens.ts}) are held
 * to (contracts.md section 4, D4) - one shared truth for what every {@code {{$...}}} token resolves
 * to, so a resent call's dynamic tokens never disagree with what the UI previewed.
 */
class DynamicTokensVectorTest {

    @TestFactory
    Stream<DynamicTest> vectors() throws IOException {
        JsonNode root = new ObjectMapper().readTree(findVectorsFile().toFile());
        Instant now = Instant.parse(root.get("now").asText());
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);

        Map<String, String> variables = new HashMap<>();
        root.get("variables").fields().forEachRemaining(entry -> variables.put(entry.getKey(), entry.getValue().asText()));

        return StreamSupport.stream(root.get("cases").spliterator(), false)
                .map(node -> DynamicTest.dynamicTest(node.get("input").asText(), () -> {
                    String input = node.get("input").asText();
                    String actual = DynamicTokens.resolve(input, variables::get, clock);
                    if (node.has("expectRegex")) {
                        assertThat(actual).matches(Pattern.compile(node.get("expectRegex").asText()));
                    } else {
                        assertThat(actual).isEqualTo(node.get("expect").asText());
                    }
                }));
    }

    /** {@code specs/002-power-features/} lives at the repo root; a module's working directory does not. */
    private static Path findVectorsFile() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("specs/002-power-features/dynamic-token-vectors.json");
            if (Files.exists(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new UncheckedIOException(new IOException(
                "Could not find specs/002-power-features/dynamic-token-vectors.json above " + Path.of("").toAbsolutePath()));
    }
}
