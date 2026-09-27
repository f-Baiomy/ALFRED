package com.fathy.alfred.backend.scenarios.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * A named, frontend-authored automation scenario. {@code definition} is an opaque
 * ScenarioDefinition JSON document (contracts/002-power-features section 3) - this slice never
 * looks inside it, only stores and returns it verbatim as a {@link JsonNode} (Jackson is allowed
 * in the domain; see CLAUDE.md's ArchUnit note). {@code lastRun} is null until the scenario has at
 * least one run, and reflects the most recently created run regardless of whether it "passed".
 */
public record Scenario(
        String id,
        String name,
        String description,
        JsonNode definition,
        String createdAt,
        String updatedAt,
        RunOutcome lastRun
) {
}
