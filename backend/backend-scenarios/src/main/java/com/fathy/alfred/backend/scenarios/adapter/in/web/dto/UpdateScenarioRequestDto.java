package com.fathy.alfred.backend.scenarios.adapter.in.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * Web-layer input for PUT /scenarios/{id} - a full replace (see ScenarioUpdate's doc), not a
 * partial patch, so every field is required just like CreateScenarioRequestDto.
 */
public record UpdateScenarioRequestDto(
        @NotBlank @Size(max = 80) String name,
        String description,
        @NotNull JsonNode definition
) {
}
