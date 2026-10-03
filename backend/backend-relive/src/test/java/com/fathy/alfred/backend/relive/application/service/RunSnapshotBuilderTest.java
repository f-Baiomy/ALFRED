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
import com.fathy.alfred.backend.relive.domain.model.VariableChange;
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
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
    }

    private Run run(ReliveCycle cycle) {
        return new Run("r-1", cycle.id(), "AUTOMATIC", RunStatus.RUNNING, "t0", null, cycle, null,
                List.of(), List.of(), null, null, List.of(), List.of());
    }

    @Test
    void anAutomaticRunLeavesInboundCheckpointsToTheTab() throws Exception {
        // T082: the reverse proxy held a step's "pause after", then the tab held it again.
        JsonNode rule = objectMapper.readTree("""
                { "name": "book", "enabled": true, "priority": 0, "stopProcessing": false, "match": {},
                  "actions": [ { "type": "PAUSE_RESPONSE", "enabled": true, "timeoutSeconds": 30 },
                               { "type": "SET_REQUEST_HEADER", "enabled": true, "name": "X-A", "value": "1" } ] }
                """);
        Step book = child("s-book", null, recording("https://app.local/book", "POST", "{}"), rule);
        ReliveCycle cycle = cycle(List.of(book), new GlobalRulesSelection("NONE", List.of()), List.of());

        JsonNode automatic = builder.build(run(cycle)).get("steps").get(0).get("callRule").get("actions");
        Run guidedRun = new Run("r-1", cycle.id(), "GUIDED", RunStatus.RUNNING, "t0", null, cycle, null,
                List.of(), List.of(), null, null, List.of(), List.of());
        JsonNode guided = builder.build(guidedRun).get("steps").get(0).get("callRule").get("actions");

        assertThat(automatic).extracting(a -> a.get("type").asText()).containsExactly("SET_REQUEST_HEADER");
        assertThat(guided).extracting(a -> a.get("type").asText()).containsExactly("PAUSE_RESPONSE", "SET_REQUEST_HEADER");
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
    void defaultChildMatchUsesAPythonCompatibleLiteralPathRegex() throws Exception {
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        Step outbound = child("c-supplier", "s-search",
                recording("https://api.supplier.test/api/search.v1+next", "POST", "{}"),
                objectMapper.createObjectNode());

        JsonNode snapshot = builder.build(run(cycle(List.of(root, outbound), new GlobalRulesSelection("NONE", List.of()), List.of())));

        String pathRegex = snapshot.path("steps").get(0).path("children").get(0).path("match").path("pathRegex").asText();
        assertThat(pathRegex).isEqualTo("^/api/search\\.v1\\+next$");
        assertThat(pathRegex).doesNotContain("\\Q", "\\E");
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
    void latestRunVariableValueOverridesTheCycleInitialValue() {
        ReliveCycle cycle = cycleWithVariables(List.of(), List.of(new CycleVariable("token", "initial", false, null)));
        Run current = new Run("r-1", cycle.id(), "AUTOMATIC", RunStatus.RUNNING, "t0", null, cycle, null,
                List.of(), List.of(new VariableChange("token", "captured", "s-1", "t1")),
                null, null, List.of(), List.of());

        assertThat(builder.build(current).get("variables").get("token").asText()).isEqualTo("captured");
    }

    @Test
    void extractionsThatRememberTheRecordedValueArePublishedAsSwaps() throws Exception {
        JsonNode extract = objectMapper.readTree("""
                [{"from":"COOKIE","path":"JSESSIONID","as":"JSESSIONID","missing":"SKIP","recordedValue":"5BHTcx"},
                 {"from":"JSON","path":"data.id","as":"bookingId","missing":"SKIP"}]
                """);
        Step login = new Step("s-login", null, "login", true, false, "inbound", "odeysys",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK",
                recording("http://localhost/loginAction", "POST", "{}"),
                new StepSource("s-login", null, "inbound"),
                extract, objectMapper.createArrayNode(), List.of(), null, null);

        JsonNode published = builder.build(run(cycleWithVariables(List.of(login), List.of())));

        assertThat(published.path("swaps")).hasSize(1);
        assertThat(published.path("swaps").get(0).path("name").asText()).isEqualTo("JSESSIONID");
        assertThat(published.path("swaps").get(0).path("recorded").asText()).isEqualTo("5BHTcx");
        assertThat(published.path("replayIgnoresCredentials").asBoolean()).isTrue();
    }

    @Test
    void credentialsCountInAReplayMatchWhenTheCycleTurnsItOff() {
        ReliveCycle base = cycleWithVariables(List.of(), List.of());
        ReliveCycle strict = new ReliveCycle(base.id(), base.name(), null, base.steps(), base.variables(), List.of(),
                base.globalRules(), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of(), true, false),
                List.of(), base.unexpectedCalls(), "t0", "t0", false, null);

        assertThat(builder.build(run(strict)).path("replayIgnoresCredentials").asBoolean()).isFalse();
    }

    @Test
    void inboundStepRuleIsPublishedSoItsResponseCaptureCanRun() throws Exception {
        JsonNode captureRule = objectMapper.readTree("""
                {"name":"capture session","enabled":true,"match":{},"actions":[
                  {"type":"CAPTURE_RESPONSE_VARIABLE","enabled":true,"name":"session_id",
                   "captureSource":"COOKIE","path":"JSESSIONID","scope":"RELIVE"}]}
                """);
        Step root = new Step("s-login", null, "login", true, false, "inbound", "odeysys",
                new CycleRule(captureRule, null), "BLOCK",
                recording("http://localhost/loginAction", "POST", "{}"),
                new StepSource("s-login", null, "inbound"),
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);

        JsonNode published = builder.build(run(cycleWithVariables(List.of(root),
                List.of(new CycleVariable("session_id", "initial", false, null)))));

        JsonNode stepRule = published.path("steps").get(0).path("callRule");
        assertThat(stepRule.path("name").asText()).isEqualTo("capture session");
        assertThat(stepRule.path("actions").get(0).path("scope").asText()).isEqualTo("RELIVE");
        assertThat(stepRule.path("actions").get(0).path("name").asText()).isEqualTo("session_id");
        assertThat(stepRule.path("actions").get(0).path("path").asText()).isEqualTo("JSESSIONID");
        assertThat(published.path("variables").path("session_id").asText()).isEqualTo("initial");
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
    void aLargeMockIsWrittenAsAStoredAnswerAndTheChildStaysReplay() throws Exception {
        String big = "x".repeat(RunSnapshotBuilder.INLINE_BODY_LIMIT + 1);
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        Step c1 = child("c-supA", "s-search", recording("https://api.supplier-a.com/v2/search", "POST", "{}"),
                ruleWithRecordedCallCondition("c-supA", "200", big));
        JsonNode snapshot = builder.build(run(cycle(List.of(root, c1), new GlobalRulesSelection("NONE", List.of()), List.of())));

        JsonNode child = snapshot.get("steps").get(0).get("children").get(0);
        assertThat(child.get("mode").asText()).isEqualTo("REPLAY");
        JsonNode answer = child.get("callRule").get("actions").get(1);
        assertThat(answer.get("type").asText()).isEqualTo("ANSWER_WITH_FILE");
        assertThat(writtenAnswers.get(answer.get("answerId").asText())[1].asText()).isEqualTo(big);
        assertThat(snapshot.toString()).doesNotContain(big);
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
        JsonNode recorded = snapshot.get("steps").get(0).get("children").get(0).get("recordedRequest");
        assertThat(recorded.get("host").asText()).isEqualTo("api.supplier-a.com");
        assertThat(recorded.get("scheme").asText()).isEqualTo("https");
        assertThat(recorded.get("path").asText()).isEqualTo("/v2/search");
        assertThat(writtenAnswers.get(answerId)[0].get("host").asText()).isEqualTo("api.supplier-a.com");

        // Review P3: republishing the same run names the same answer file.
        JsonNode again = builder.build(run(cycle));
        assertThat(again.get("steps").get(0).get("children").get(0).get("callRule").get("actions").get(0)
                .get("branches").get(0).get("conditions").get(0).get("answerId").asText()).isEqualTo(answerId);
        assertThat(writtenAnswers).hasSize(1);
    }

    @Test
    void aStoredFingerprintIsCopiedAndAMissingOneIsLeftOff() {
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        Step stamped = child("c-stamped", "s-search",
                recording("https://api.supplier.com/search", "POST", "{\"not\":\"read at publish\"}"),
                objectMapper.createObjectNode()).withFingerprint("not-a-real-hash", "SEMANTIC_V1");
        Step legacy = child("c-legacy", "s-search",
                recording("https://api.supplier.com/other", "POST", "{\"also\":\"unread\"}"),
                objectMapper.createObjectNode());

        ReliveCycle stored = cycle(List.of(root, stamped, legacy), new GlobalRulesSelection("NONE", List.of()), List.of());
        ReliveCycle indexed = new ReliveCycle(stored.id(), stored.name(), stored.description(), stored.steps(),
                stored.variables(), stored.cycleRules(), stored.globalRules(), stored.settings(), stored.noise(),
                stored.unexpectedCalls(), stored.createdAt(), stored.updatedAt(), stored.isTransient(), stored.lastRun(),
                StepFingerprints.indexes(stored.steps()));

        JsonNode snapshot = builder.build(run(indexed));

        JsonNode parent = snapshot.get("steps").get(0);
        assertThat(parent.has("fingerprint")).isFalse();
        JsonNode first = parent.get("children").get(0);
        assertThat(first.get("fingerprint").asText()).isEqualTo("not-a-real-hash");
        assertThat(first.get("fingerprintVersion").asText()).isEqualTo("SEMANTIC_V1");
        assertThat(first.get("enabled").asBoolean()).isTrue();
        assertThat(parent.get("children").get(1).has("fingerprint")).isFalse();
        assertThat(parent.get("fingerprintIndex").get("not-a-real-hash").get(0).asText()).isEqualTo("c-stamped");
        assertThat(parent.get("fingerprintIndex").size()).isEqualTo(1);
        assertThat(writtenAnswers).isEmpty();
    }

    @Test
    void aNullIndexIsPublishedWithoutBeingRebuilt() {
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        Step stamped = child("c-stamped", "s-search",
                recording("https://api.supplier.com/search", "POST", "{\"not\":\"read at publish\"}"),
                objectMapper.createObjectNode()).withFingerprint("not-a-real-hash", "SEMANTIC_V1");
        Step disabled = new Step("c-off", "s-search", "label", false, false, "outbound", "odeysys",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK",
                recording("https://api.supplier.com/off", "POST", "{\"off\":true}"),
                new StepSource("c-off", null, "outbound"),
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(),
                "hash-off", "SEMANTIC_V1");

        JsonNode snapshot = builder.build(run(cycle(List.of(root, stamped, disabled),
                new GlobalRulesSelection("NONE", List.of()), List.of())));

        JsonNode parent = snapshot.get("steps").get(0);
        assertThat(parent.has("fingerprintIndex")).isFalse();
        assertThat(parent.get("children").get(0).get("fingerprint").asText()).isEqualTo("not-a-real-hash");
        assertThat(parent.get("children").get(1).get("enabled").asBoolean()).isFalse();
        assertThat(parent.get("children").get(1).get("fingerprint").asText()).isEqualTo("hash-off");
        assertThat(writtenAnswers).isEmpty();
    }

    @Test
    void nestedInboundKeepsItsOwnOutboundChild() throws Exception {
        Step root = child("s-search", null, recording("https://app.local/search", "POST", "{}"), objectMapper.createObjectNode());
        FrozenCall innerCall = new FrozenCall("POST", "http://core.local/search", Map.of(), "{}", 200, Map.of(), "{}",
                "2026-09-27T10:00:00Z", 300, null, null, "core", "inbound");
        Step inner = new Step("s-core", "s-search", "core", true, false, "inbound", "core",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", innerCall,
                new StepSource("s-core", null, "inbound"),
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
        Step supplier = child("c-supplier", "s-core",
                recording("https://ndc.example/api/FlightSearch/Search", "POST", "{\"a\":1}"),
                objectMapper.createObjectNode());

        JsonNode snapshot = builder.build(run(cycle(List.of(root, inner, supplier), new GlobalRulesSelection("NONE", List.of()), List.of())));

        JsonNode core = snapshot.get("steps").get(0).get("children").get(0);
        assertThat(core.get("direction").asText()).isEqualTo("inbound");
        assertThat(core.get("match").get("source").asText()).isEqualTo("inbound");
        JsonNode outbound = core.get("children").get(0);
        assertThat(outbound.get("stepKey").asText()).isEqualTo("c-supplier");
        assertThat(outbound.get("direction").asText()).isEqualTo("outbound");
        assertThat(outbound.get("recordedRequest").get("host").asText()).isEqualTo("ndc.example");
        assertThat(outbound.get("recordedRequest").get("path").asText()).isEqualTo("/api/FlightSearch/Search");
        assertThat(snapshot.get("projects")).extracting(JsonNode::asText).contains("core", "odeysys");
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
