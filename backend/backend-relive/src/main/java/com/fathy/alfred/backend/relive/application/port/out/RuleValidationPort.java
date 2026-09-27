package com.fathy.alfred.backend.relive.application.port.out;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/** Outbound port to backend-interception's RuleValidator, via an APP bridge (T015) - this slice
 *  never depends on backend-interception directly (ArchUnit T016). */
public interface RuleValidationPort {

    /** Empty when the rule document is valid; otherwise one message per problem. */
    List<String> validate(JsonNode ruleDoc);
}
