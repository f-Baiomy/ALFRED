package com.fathy.alfred.backend.interception.adapter.out.rulesfile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import com.fathy.alfred.backend.interception.domain.model.SelfTargets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class FileRulesPublisherAdapterTest {

    @TempDir
    Path tempDir;

    private FileRulesPublisherAdapter adapterFor(Path file) {
        FileRulesPublisherAdapter adapter = new FileRulesPublisherAdapter(
                new SelfTargets(Set.of("backend"), Set.of("localhost:5000")));
        ReflectionTestUtils.setField(adapter, "rulesFile", file.toString());
        return adapter;
    }

    private static InterceptionRule rule(String id, String name, boolean enabled, int priority) {
        return new InterceptionRule(id, name, null, enabled, priority, false,
                new RuleMatch("outbound", null, List.of(), List.of("POST"), "*.sabre.com", "/order", null),
                List.of(new RuleAction(ActionType.DELAY_REQUEST, 5000, null, null, null, null, null, null, null, null, null, null, null)),
                "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    }

    @Test
    void writesTheShapeTheProxyReads() throws Exception {
        Path file = tempDir.resolve("interception-rules.json");
        adapterFor(file).publish(true, List.of(rule("a", "Slow Sabre", true, 10)));

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("enabled").asBoolean()).isTrue();
        assertThat(root.get("rules")).hasSize(1);

        JsonNode published = root.get("rules").get(0);
        assertThat(published.get("id").asText()).isEqualTo("a");
        assertThat(published.get("priority").asInt()).isEqualTo(10);
        assertThat(published.get("match").get("host").asText()).isEqualTo("*.sabre.com");
        assertThat(published.get("actions").get(0).get("type").asText()).isEqualTo("DELAY_REQUEST");
        assertThat(published.get("actions").get(0).get("durationMs").asInt()).isEqualTo(5000);
    }

    @Test
    void publishesTheSecretNamesSelfTargetsAndLimitsTheProxyChecksAgainst() throws Exception {
        Path file = tempDir.resolve("rules.json");
        adapterFor(file).publish(true, List.of(rule("a", "Slow Sabre", true, 10)));

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("sensitiveHeaders")).extracting(JsonNode::asText)
                .contains("authorization", "cookie", "set-cookie");
        assertThat(root.get("selfTargets")).extracting(JsonNode::asText)
                .containsExactlyInAnyOrder("backend", "localhost:5000");
        assertThat(root.get("limits").get("maxPatternLength").asInt()).isEqualTo(500);
        assertThat(root.get("limits").get("regexTimeoutMs").asInt()).isEqualTo(2000);
    }

    @Test
    void disabledRulesAreNotPublishedAtAll() throws Exception {
        Path file = tempDir.resolve("rules.json");
        adapterFor(file).publish(true, List.of(
                rule("on", "Enabled", true, 10),
                rule("off", "Disabled", false, 20)));

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("rules")).hasSize(1);
        assertThat(root.get("rules").get(0).get("id").asText()).isEqualTo("on");
    }

    @Test
    void theMasterSwitchIsCarriedIndependentlyOfTheRules() throws Exception {
        Path file = tempDir.resolve("rules.json");
        adapterFor(file).publish(false, List.of(rule("a", "Still here", true, 10)));

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("enabled").asBoolean()).isFalse();
        // The rules are still published: the proxy honours the master switch itself, so turning
        // it back on must not need a republish of every rule.
        assertThat(root.get("rules")).hasSize(1);
    }

    @Test
    void publishingCreatesMissingDirectories() {
        Path file = tempDir.resolve("nested/deeper/rules.json");
        adapterFor(file).publish(true, List.of());

        assertThat(file).exists();
    }

    @Test
    void republishingReplacesRatherThanAppends() throws Exception {
        Path file = tempDir.resolve("rules.json");
        FileRulesPublisherAdapter adapter = adapterFor(file);

        adapter.publish(true, List.of(rule("a", "First", true, 10)));
        adapter.publish(true, List.of(rule("b", "Second", true, 10)));

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("rules")).hasSize(1);
        assertThat(root.get("rules").get(0).get("id").asText()).isEqualTo("b");
    }

    @Test
    void noTemporaryFilesAreLeftBehind() throws Exception {
        Path file = tempDir.resolve("rules.json");
        adapterFor(file).publish(true, List.of(rule("a", "A", true, 10)));

        try (var entries = Files.list(tempDir)) {
            assertThat(entries.map(p -> p.getFileName().toString()))
                    .containsExactly("rules.json");
        }
    }

    @Test
    void mockResponseBodiesSurviveTheRoundTrip() throws Exception {
        Path file = tempDir.resolve("rules.json");
        InterceptionRule mock = new InterceptionRule("m", "Mock 500", null, true, 10, false,
                RuleMatch.empty(),
                List.of(new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                        Map.of("Content-Type", "application/json"),
                        "{\"error\":\"Simulated supplier failure\"}", null, null, null, null, null)),
                null, null);

        adapterFor(file).publish(true, List.of(mock));

        JsonNode action = new ObjectMapper().readTree(Files.readString(file))
                .get("rules").get(0).get("actions").get(0);
        assertThat(action.get("status").asInt()).isEqualTo(500);
        assertThat(action.get("headers").get("Content-Type").asText()).isEqualTo("application/json");
        assertThat(action.get("body").asText()).contains("Simulated supplier failure");
    }
}
