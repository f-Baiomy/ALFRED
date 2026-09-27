package com.fathy.alfred.backend.scenarios.adapter.in.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.scenarios.domain.model.RunOutcome;
import jakarta.validation.constraints.NotNull;

/**
 * Web-layer input for POST /scenarios/{id}/runs - "Run without id/scenarioId"
 * (contracts/002-power-features section 3). {@code summary} reuses the domain RunOutcome record
 * directly (plain int fields, no validation concern, wire shape matches exactly - see the
 * DTO-vs-domain-reuse rule).
 */
public record CreateRunRequestDto(
        String startedAt,
        String finishedAt,
        @NotNull RunOutcome summary,
        JsonNode results
) {
}
