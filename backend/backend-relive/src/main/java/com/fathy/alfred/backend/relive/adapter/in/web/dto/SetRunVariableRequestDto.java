package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Body of {@code POST /relive-cycles/{id}/runs/{runId}/variables}. */
public record SetRunVariableRequestDto(@NotBlank String name, String value, String stepKey) {
}
