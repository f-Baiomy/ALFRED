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
}
