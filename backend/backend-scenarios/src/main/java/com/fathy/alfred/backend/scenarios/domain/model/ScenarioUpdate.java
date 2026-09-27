package com.fathy.alfred.backend.scenarios.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Input to UpdateScenarioUseCase. Unlike ProfileUpdate, this is a FULL replace of name/description
 * /definition (contracts/002-power-features section 3's PUT body always carries all three) - there
 * is no partial-update semantics here, so every field is required rather than "null means leave
 * alone".
 */
public record ScenarioUpdate(
        String name,
        String description,
        JsonNode definition
) {
}
