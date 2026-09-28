package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

/** Body of {@code PUT /relive-cycles/{id}/runs/{runId}/definition} (FR-044a). */
public record UpdateRunDefinitionRequestDto(@Valid @NotNull ReliveCycleRequestDto definition, String reason) {
}
