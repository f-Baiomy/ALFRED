package com.fathy.alfred.backend.relivebridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleValidator;
import com.fathy.alfred.backend.relive.application.port.out.RuleValidationPort;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.ArrayList;

/**
 * Bridges Relive's opaque rule documents to backend-interception's RuleValidator, so a call
 * rule / cycle rule / unexpected-call rule is checked against the very same rules a global rule
 * would be (FR-029a) - Relive never re-implements or duplicates that validation. Lives in
 * backend-app because Relive must not depend on backend-interception directly (ArchUnit T016).
 */
@Component
public class RuleValidationAdapter implements RuleValidationPort {

    private final ObjectMapper objectMapper;

    public RuleValidationAdapter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public List<String> validate(JsonNode ruleDoc) {
        if (ruleDoc == null || ruleDoc.isNull()) {
            return List.of("rule document is missing");
        }
        try {
            // The shared validator is intentionally GLOBAL/LOCAL only for ordinary rules.
            // RELIVE has the same action shape as LOCAL, but can be published only by this bridge.
            JsonNode validationDoc = ruleDoc.deepCopy();
            normalizeReliveScopes(validationDoc);
            InterceptionRule rule = objectMapper.treeToValue(validationDoc, InterceptionRule.class);
            List<String> problems = new ArrayList<>(RuleValidator.validate(rule));
            // Relive's generated replay rule deliberately lets a matching recorded request
            // fall through to the following MOCK_RESPONSE; its ELSE answers a mismatch.
            // The generic validator sees the empty IF branch as useless, even though here
            // it selects between those two terminal answers.
            int fallthroughs = replayFallthroughs(ruleDoc);
            while (fallthroughs-- > 0) {
                if (!problems.remove("An IF branch that does nothing when it matches has no effect - remove it.")) break;
            }
            return problems;
        } catch (Exception e) {
            return List.of("rule document could not be parsed: " + e.getMessage());
        }
    }

    private static void normalizeReliveScopes(JsonNode node) {
        if (node.isObject()) {
            ObjectNode object = (ObjectNode) node;
            if ("RELIVE".equals(object.path("scope").asText())) {
                object.put("scope", "LOCAL");
            }
            object.elements().forEachRemaining(RuleValidationAdapter::normalizeReliveScopes);
        } else if (node.isArray()) {
            node.elements().forEachRemaining(RuleValidationAdapter::normalizeReliveScopes);
        }
    }

    private static int replayFallthroughs(JsonNode ruleDoc) {
        JsonNode actions = ruleDoc.path("actions");
        if (!actions.isArray()) return 0;
        int count = 0;
        for (int i = 0; i < actions.size(); i++) {
            JsonNode action = actions.get(i);
            if (!"IF_REQUEST".equals(action.path("type").asText())) continue;
            JsonNode branches = action.path("branches");
            if (!branches.isArray() || branches.size() != 1) continue;
            JsonNode branch = branches.get(0);
            JsonNode conditions = branch.path("conditions");
            if (!branch.path("actions").isArray() || !branch.path("actions").isEmpty()
                    || !conditions.isArray() || conditions.size() != 1
                    || !"RECORDED_CALL".equals(conditions.get(0).path("subject").asText())
                    || !action.path("otherwise").isArray() || action.path("otherwise").isEmpty()) continue;
            for (int j = i + 1; j < actions.size(); j++) {
                if ("MOCK_RESPONSE".equals(actions.get(j).path("type").asText())
                        && actions.get(j).path("enabled").asBoolean(true)) {
                    count++;
                    break;
                }
            }
        }
        return count;
    }
}
