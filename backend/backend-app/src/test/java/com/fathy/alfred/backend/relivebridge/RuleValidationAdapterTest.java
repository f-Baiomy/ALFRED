package com.fathy.alfred.backend.relivebridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class RuleValidationAdapterTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RuleValidationAdapter adapter = new RuleValidationAdapter(objectMapper);

    @Test
    void validMockResponseRuleGivesNoErrors() throws Exception {
        JsonNode rule = objectMapper.readTree("""
                {
                  "id": "r-1",
                  "name": "Mock supplier A",
                  "enabled": true,
                  "priority": 0,
                  "stopProcessing": false,
                  "match": {},
                  "actions": [
                    { "type": "MOCK_RESPONSE", "status": 200, "headers": {}, "body": "{}" }
                  ]
                }
                """);

        assertThat(adapter.validate(rule)).isEmpty();
    }

    @Test
    void aCheckpointOnAReplayChildIsValid() throws Exception {
        // T082: pause before and pause after a REPLAY mock could not be saved - releasing a
        // Relive pause carries on with the rest of the call rule.
        JsonNode rule = objectMapper.readTree("""
                {
                  "id": "r-1",
                  "name": "Supplier A",
                  "enabled": true,
                  "priority": 0,
                  "stopProcessing": false,
                  "match": {},
                  "actions": [
                    { "type": "PAUSE_REQUEST", "timeoutSeconds": 30, "onTimeout": "release" },
                    { "type": "MOCK_RESPONSE", "status": 200, "headers": {}, "body": "{}" },
                    { "type": "PAUSE_RESPONSE", "timeoutSeconds": 30, "onTimeout": "release" }
                  ]
                }
                """);

        assertThat(adapter.validate(rule)).isEmpty();
    }

    @Test
    void reliveReplayRuleMayFallThroughAfterARecordedCallMatch() throws Exception {
        JsonNode rule = objectMapper.readTree("""
                {
                  "name": "POST /supplier/search",
                  "enabled": true,
                  "priority": 0,
                  "stopProcessing": true,
                  "match": {},
                  "actions": [
                    { "type": "IF_REQUEST", "enabled": true,
                      "branches": [{ "conditions": [{ "subject": "RECORDED_CALL", "operator": "MATCHES", "recordedStepKey": "step-1", "ignore": [] }], "actions": [] }],
                      "otherwise": [{ "type": "MOCK_RESPONSE", "enabled": true, "status": 502, "headers": {}, "body": "different" }] },
                    { "type": "MOCK_RESPONSE", "enabled": true, "status": 200, "headers": {}, "body": "recorded" }
                  ]
                }
                """);

        assertThat(adapter.validate(rule)).isEmpty();
    }

    @Test
    void recordedCallBranchStaysValidWhenTheReplayMockIsSwitchedOff() throws Exception {
        JsonNode rule = objectMapper.readTree("""
                {
                  "name": "POST /supplier/search",
                  "enabled": true,
                  "priority": 0,
                  "stopProcessing": true,
                  "match": {},
                  "actions": [
                    { "type": "IF_REQUEST", "enabled": true,
                      "branches": [{ "conditions": [{ "subject": "RECORDED_CALL", "operator": "MATCHES", "recordedStepKey": "step-1", "ignore": [] }], "actions": [] }],
                      "otherwise": [{ "type": "MOCK_RESPONSE", "enabled": true, "status": 502, "headers": {}, "body": "different" }] },
                    { "type": "MOCK_RESPONSE", "enabled": false, "status": 200, "headers": {}, "body": "recorded" }
                  ]
                }
                """);

        assertThat(adapter.validate(rule)).isEmpty();
    }

    @Test
    void emptyIfBranchThatIsNotARecordedCallFallthroughIsStillRejected() throws Exception {
        JsonNode rule = objectMapper.readTree("""
                {
                  "name": "POST /supplier/search",
                  "enabled": true,
                  "priority": 0,
                  "stopProcessing": true,
                  "match": {},
                  "actions": [
                    { "type": "IF_REQUEST", "enabled": true,
                      "branches": [{ "conditions": [{ "subject": "METHOD", "operator": "EQUALS", "value": "POST" }], "actions": [] }],
                      "otherwise": [{ "type": "MOCK_RESPONSE", "enabled": true, "status": 502, "headers": {}, "body": "different" }] }
                  ]
                }
                """);

        assertThat(adapter.validate(rule))
                .contains("An IF branch that does nothing when it matches has no effect - remove it.");
    }

    @Test
    void unknownActionTypeGivesAnError() throws Exception {
        JsonNode rule = objectMapper.readTree("""
                {
                  "id": "r-2",
                  "name": "Bogus",
                  "enabled": true,
                  "priority": 0,
                  "stopProcessing": false,
                  "match": {},
                  "actions": [
                    { "type": "TOTALLY_BOGUS_ACTION" }
                  ]
                }
                """);

        assertThat(adapter.validate(rule)).isNotEmpty();
    }

    @Test
    void missingRuleDocumentGivesAnError() {
        assertThat(adapter.validate(null)).containsExactly("rule document is missing");
    }

    @Test
    void reliveVariableScopeIsAcceptedWithoutChangingTheOriginalRule() throws Exception {
        JsonNode rule = objectMapper.readTree("""
                {"name":"capture session","match":{},"actions":[
                  {"type":"SET_REQUEST_VARIABLE","name":"sessionId","value":"abc","scope":"RELIVE"}
                ]}
                """);
        assertThat(adapter.validate(rule)).isEmpty();
        assertThat(rule.path("actions").get(0).path("scope").asText()).isEqualTo("RELIVE");
    }
}
