package com.fathy.alfred.backend.interception.adapter.out.rulesfile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.application.port.out.RulesPublisherPort;
import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import com.fathy.alfred.backend.interception.domain.model.SelfTargets;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
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
        adapterFor(file).publish(true, List.of(rule("a", "Slow Sabre", true, 10)), List.of());

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
        adapterFor(file).publish(true, List.of(rule("a", "Slow Sabre", true, 10)), List.of());

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
                rule("off", "Disabled", false, 20)), List.of());

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("rules")).hasSize(1);
        assertThat(root.get("rules").get(0).get("id").asText()).isEqualTo("on");
    }

    @Test
    void theMasterSwitchIsCarriedIndependentlyOfTheRules() throws Exception {
        Path file = tempDir.resolve("rules.json");
        adapterFor(file).publish(false, List.of(rule("a", "Still here", true, 10)), List.of());

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("enabled").asBoolean()).isFalse();
        // The rules are still published: the proxy honours the master switch itself, so turning
        // it back on must not need a republish of every rule.
        assertThat(root.get("rules")).hasSize(1);
    }

    @Test
    void publishingCreatesMissingDirectories() {
        Path file = tempDir.resolve("nested/deeper/rules.json");
        adapterFor(file).publish(true, List.of(), List.of());

        assertThat(file).exists();
    }

    @Test
    void republishingReplacesRatherThanAppends() throws Exception {
        Path file = tempDir.resolve("rules.json");
        FileRulesPublisherAdapter adapter = adapterFor(file);

        adapter.publish(true, List.of(rule("a", "First", true, 10)), List.of());
        adapter.publish(true, List.of(rule("b", "Second", true, 10)), List.of());

        JsonNode root = new ObjectMapper().readTree(Files.readString(file));
        assertThat(root.get("rules")).hasSize(1);
        assertThat(root.get("rules").get(0).get("id").asText()).isEqualTo("b");
    }

    @Test
    void noTemporaryFilesAreLeftBehind() throws Exception {
        Path file = tempDir.resolve("rules.json");
        adapterFor(file).publish(true, List.of(rule("a", "A", true, 10)), List.of());

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

        adapterFor(file).publish(true, List.of(mock), List.of());

        JsonNode action = new ObjectMapper().readTree(Files.readString(file))
                .get("rules").get(0).get("actions").get(0);
        assertThat(action.get("status").asInt()).isEqualTo(500);
        assertThat(action.get("headers").get("Content-Type").asText()).isEqualTo("application/json");
        assertThat(action.get("body").asText()).contains("Simulated supplier failure");
    }

    private static final String ANSWER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    private static RulesPublisherPort.PublishedAnswer answer(String id, java.util.concurrent.atomic.AtomicInteger reads) {
        StoredAnswer meta = new StoredAnswer(id, StoredAnswer.Kind.RECORDED, 503,
                java.util.Map.of("content-type", "application/json"), "application/json", 2, true,
                List.of("set-cookie"), "outbound", "call-1", null, null, "2026-09-23T12:00:00Z");
        return new RulesPublisherPort.PublishedAnswer(meta, () -> {
            reads.incrementAndGet();
            return "{}".getBytes();
        });
    }

    @Test
    void answersAreWrittenBesideTheSnapshotAndBeforeIt() throws Exception {
        Path file = tempDir.resolve("rules.json");
        var reads = new java.util.concurrent.atomic.AtomicInteger();

        adapterFor(file).publish(true, List.of(rule("a", "Replay", true, 10)), List.of(answer(ANSWER, reads)));

        Path body = tempDir.resolve("answers").resolve(ANSWER + ".body");
        Path meta = tempDir.resolve("answers").resolve(ANSWER + ".meta.json");
        assertThat(Files.readString(body)).isEqualTo("{}");
        JsonNode published = new ObjectMapper().readTree(Files.readString(meta));
        assertThat(published.get("status").asInt()).isEqualTo(503);
        assertThat(published.get("headers").get("content-type").asText()).isEqualTo("application/json");
        // What the proxy has no use for is not handed to it.
        assertThat(published.has("secretNames")).isFalse();
        assertThat(published.has("sourceCallId")).isFalse();
        assertThat(Files.getLastModifiedTime(meta).toMillis()).isLessThanOrEqualTo(Files.getLastModifiedTime(file).toMillis());
    }

    @Test
    void anAnswerAlreadyPublishedIsNotReadOrWrittenAgain() throws Exception {
        Path file = tempDir.resolve("rules.json");
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        FileRulesPublisherAdapter adapter = adapterFor(file);

        adapter.publish(true, List.of(rule("a", "Replay", true, 10)), List.of(answer(ANSWER, reads)));
        adapter.publish(true, List.of(rule("a", "Replay", true, 10)), List.of(answer(ANSWER, reads)));

        assertThat(reads.get()).isEqualTo(1);
    }

    @Test
    void answersNoPublishedRuleUsesAreDeleted() throws Exception {
        Path file = tempDir.resolve("rules.json");
        FileRulesPublisherAdapter adapter = adapterFor(file);
        adapter.publish(true, List.of(rule("a", "Replay", true, 10)),
                List.of(answer(ANSWER, new java.util.concurrent.atomic.AtomicInteger())));

        adapter.publish(true, List.of(rule("a", "Replay", true, 10)), List.of());

        try (var files = Files.list(tempDir.resolve("answers"))) {
            assertThat(files.toList()).isEmpty();
        }
    }

    @Test
    void anAnswerWithAnInvalidIdIsNeverJoinedOntoAPath() throws Exception {
        Path file = tempDir.resolve("rules.json");

        adapterFor(file).publish(true, List.of(), List.of(answer("../../escape", new java.util.concurrent.atomic.AtomicInteger())));

        assertThat(Files.exists(tempDir.resolve("escape.body"))).isFalse();
        assertThat(Files.exists(tempDir.getParent().resolve("escape.body"))).isFalse();
    }
}
