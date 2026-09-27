package com.fathy.alfred.backend.scenarios.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One execution of a Scenario. {@code results} is opaque JSON, same rationale as
 * Scenario.definition - this slice never inspects it, only stores/returns it verbatim.
 */
public record Run(
        String id,
        String scenarioId,
        String startedAt,
        String finishedAt,
        RunOutcome summary,
        JsonNode results
) {
}
