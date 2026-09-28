package com.fathy.alfred.backend.relive.adapter.in.web.dto;

/** Body of {@code PUT /relive-cycles/{id}/runs/{runId}/hold}. {@code reason == null} clears the hold. */
public record HoldRunRequestDto(String stepKey, String reason) {
}
