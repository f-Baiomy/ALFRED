package com.fathy.alfred.backend.scenarios.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Input to CreateScenarioUseCase - already-validated fields for a scenario that doesn't have an
 * id/createdAt/updatedAt yet (the application service assigns those). Kept distinct from the web
 * layer's CreateScenarioRequestDto, which additionally carries Bean Validation annotations - a
 * transport concern that doesn't belong here (see CLAUDE.md's DTO-vs-domain-reuse rule).
 */
public record NewScenario(
        String name,
        String description,
        JsonNode definition
) {
}
