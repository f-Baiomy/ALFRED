package com.fathy.alfred.backend.relive.adapter.in.web.dto;

/** Body of {@code POST /relive-cycles/{id}/runs/{runId}/resume}. */
public record ResumeRunRequestDto(String afterStepKey) {
}
