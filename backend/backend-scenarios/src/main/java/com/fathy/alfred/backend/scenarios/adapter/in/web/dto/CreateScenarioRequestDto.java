package com.fathy.alfred.backend.scenarios.adapter.in.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * Web-layer input for POST /scenarios. Carries Bean Validation annotations - a transport concern -
 * which is exactly why this is a distinct type from the domain's NewScenario rather than reusing
 * it directly (see the DTO-vs-domain-reuse rule in CLAUDE.md). The 20 MB size limit on
 * {@code definition} isn't expressible as a Bean Validation annotation (it depends on serialized
 * byte length, not a Java collection/string size), so it's enforced in ScenariosService instead.
 */
public record CreateScenarioRequestDto(
        @NotBlank @Size(max = 80) String name,
        String description,
        @NotNull JsonNode definition
) {
}
