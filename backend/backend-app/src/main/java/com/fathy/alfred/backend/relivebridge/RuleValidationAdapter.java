package com.fathy.alfred.backend.relivebridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleValidator;
import com.fathy.alfred.backend.relive.application.port.out.RuleValidationPort;
import org.springframework.stereotype.Component;

import java.util.List;

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
            InterceptionRule rule = objectMapper.treeToValue(ruleDoc, InterceptionRule.class);
            return RuleValidator.validate(rule);
        } catch (Exception e) {
            return List.of("rule document could not be parsed: " + e.getMessage());
        }
    }
}
