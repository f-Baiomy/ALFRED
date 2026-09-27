package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.out.RunSnapshotPublisherPort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepSource;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RunSnapshotBuilderTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Map<String, JsonNode[]> writtenAnswers = new HashMap<>(); // answerId -> [meta, bodyAsTextNode]
    private RunSnapshotBuilder builder;

    private FrozenCall recording(String url, String method, String body) {
        return new FrozenCall(method, url, Map.of("X-Trace", "abc"), body, 200, Map.of(), "{}",
                "2026-09-27T10:00:00Z", 300, null, null, "odeysys", "outbound");
    }

    @BeforeEach
    void setUp() {
        RunSnapshotPublisherPort publisher = new RunSnapshotPublisherPort() {
            @Override public void publish(String runId, JsonNode snapshotJson) { }
            @Override public void unpublish(String runId) { }
            @Override public void publishInflight(JsonNode inflightJson) { }
            @Override public void clearInflight() { }
            @Override public void writeAnswer(String runId, String answerId, JsonNode meta, byte[] body) {
                writtenAnswers.put(answerId, new JsonNode[] { meta, objectMapper.getNodeFactory().textNode(new String(body, java.nio.charset.StandardCharsets.UTF_8)) });
            }
        };
        builder = new RunSnapshotBuilder(publisher, objectMapper);
    }

    private JsonNode ruleWithRecordedCallCondition(String recordedStepKey, String status, String body) throws Exception {
        return objectMapper.readTree("""
                {
                  "name": "call rule",
                  "enabled": true,
                  "priority": 0,
                  "stopProcessing": true,
                  "match": {},
                  "actions": [
                    {
                      "type": "IF_REQUEST",
                      "enabled": true,
                      "branches": [ { "conditions": [ { "subject": "RECORDED_CALL", "operator": "MATCHES", "recordedStepKey": "%s", "ignore": [] } ], "actions": [] } ],
                      "otherwise": [ { "type": "MOCK_RESPONSE", "enabled": true, "status": 502, "headers": {}, "body": "{\\"error\\":\\"differs\\"}" } ]
                    },
                    { "type": "MOCK_RESPONSE", "enabled": true, "status": %s, "headers": {}, "body": %s }
                  ]
                }
                """.formatted(recordedStepKey, status, objectMapper.writeValueAsString(body)));
    }

    private Step child(String key, String parentKey, FrozenCall recording, JsonNode rule) {
        return new Step(key, parentKey, "label", true, false, "outbound", "odeysys",
                new CycleRule(rule, null), "BLOCK", recording, new StepSource(key, null, "outbound"),
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of());
    }

    private Run run(ReliveCycle cycle) {
        return new Run("r-1", cycle.id(), "AUTOMATIC", RunStatus.RUNNING, "t0", null, cycle, null,
                List.of(), List.of(), null, null, List.of(), List.of());
    }

    @Test
    void ordinalsAreCorrectForSiblingsSharingTheSameEndpoint() throws Exception {
        FrozenCall recA1 = recording("https://api.supplier-a.com/v2/search", "POST", "{\"a\":1}");
        FrozenCall recA2 = recording("https://api.supplier-a.com/v2/search", "POST", "{\"a\":2}");
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        Step c1 = child("c-1", "s-search", recA1, ruleWithRecordedCallCondition("c-1", "200", "{\"a\":1}"));
        Step c2 = child("c-2", "s-search", recA2, ruleWithRecordedCallCondition("c-2", "200", "{\"a\":2}"));

        ReliveCycle cycle = cycle(List.of(root, c1, c2), new GlobalRulesSelection("NONE", List.of()), List.of());
        JsonNode snapshot = builder.build(run(cycle));

        JsonNode children = snapshot.get("steps").get(0).get("children");
        assertThat(children.get(0).get("ordinal").asInt()).isEqualTo(1);
        assertThat(children.get(1).get("ordinal").asInt()).isEqualTo(2);
    }

    @Test
    void secretVariableNamesAreListed() throws Exception {
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        ReliveCycle cycle = cycleWithVariables(List.of(root),
                List.of(new CycleVariable("token", "abc123", true, null), new CycleVariable("searchId", "xyz", false, null)));

        JsonNode snapshot = builder.build(run(cycle));

        assertThat(snapshot.get("secrets")).extracting(JsonNode::asText).containsExactly("token");
        assertThat(snapshot.get("variables").get("token").asText()).isEqualTo("abc123");
    }

    @Test
    void globalRulesModeAndSelectedIdsPassThrough() {
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        ReliveCycle cycle = cycle(List.of(root), new GlobalRulesSelection("SELECTED", List.of("r-1", "r-2")), List.of());

        JsonNode snapshot = builder.build(run(cycle));

        assertThat(snapshot.get("globalRules").get("mode").asText()).isEqualTo("SELECTED");
        assertThat(snapshot.get("globalRules").get("selectedIds")).extracting(JsonNode::asText).containsExactly("r-1", "r-2");
    }

    @Test
    void everyReplayChildsConditionGetsAnAnswerIdWithTheRecordedBodyUnchangedAndNoRecordedStepKeyLeft() throws Exception {
        FrozenCall recA = recording("https://api.supplier-a.com/v2/search", "POST", "{\"origin\":\"DXB\"}");
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        Step c1 = child("c-supA", "s-search", recA, ruleWithRecordedCallCondition("c-supA", "200", "{\"results\":12}"));
        ReliveCycle cycle = cycle(List.of(root, c1), new GlobalRulesSelection("NONE", List.of()), List.of());

        JsonNode snapshot = builder.build(run(cycle));

        JsonNode childRule = snapshot.get("steps").get(0).get("children").get(0).get("callRule");
        JsonNode condition = childRule.get("actions").get(0).get("branches").get(0).get("conditions").get(0);
        assertThat(condition.has("recordedStepKey")).isFalse();
        assertThat(condition.has("answerId")).isTrue();

        String answerId = condition.get("answerId").asText();
        assertThat(writtenAnswers).containsKey(answerId);
        assertThat(writtenAnswers.get(answerId)[1].asText()).isEqualTo("{\"origin\":\"DXB\"}");
    }

    private ReliveCycle cycle(List<Step> steps, GlobalRulesSelection globalRules, List<CycleVariable> variables) {
        return new ReliveCycle("c-1", "Book flow", null, steps, variables, List.of(), globalRules,
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()), List.of(),
                new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
    }

    private ReliveCycle cycleWithVariables(List<Step> steps, List<CycleVariable> variables) {
        return cycle(steps, new GlobalRulesSelection("NONE", List.of()), variables);
    }
}
