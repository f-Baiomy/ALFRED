package com.fathy.alfred.backend.scenarios.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Input to CreateRunUseCase - "Run without id/scenarioId" per contracts/002-power-features
 * section 3: the caller (frontend, after actually executing the scenario) reports what happened,
 * and the application service assigns the id and scenarioId.
 */
public record NewRun(
        String startedAt,
        String finishedAt,
        RunOutcome summary,
        JsonNode results
) {
}
