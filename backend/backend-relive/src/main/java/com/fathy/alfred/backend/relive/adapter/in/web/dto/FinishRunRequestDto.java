package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Body of {@code POST /relive-cycles/{id}/runs/{runId}/finish}. */
public record FinishRunRequestDto(@NotBlank String status) {
}
