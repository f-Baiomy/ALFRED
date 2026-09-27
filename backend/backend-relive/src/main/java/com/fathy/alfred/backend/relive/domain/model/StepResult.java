package com.fathy.alfred.backend.relive.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * One attempt of one step (data-model.md "StepResult"). {@code effectiveRequest},
 * {@code actualRequest}, {@code actualResponse}, {@code assertions} and {@code editsApplied}
 * stay opaque {@link JsonNode}s - this slice never interprets a request/response body, only
 * stores and returns it (constitution I: no call data in logs, bodies only ever rendered
 * through the frontend's masking).
 */
public record StepResult(
        String runId,
        String stepKey,
        int attempt,
        StepState state,
        String mode,
        String attribution,
        JsonNode effectiveRequest,
        JsonNode actualRequest,
        JsonNode actualResponse,
        List<DifferenceEntry> differences,
        List<RuleApplied> rulesApplied,
        List<VariableChange> variablesUsed,
        List<VariableChange> variablesProduced,
        JsonNode assertions,
        String startedAt,
        String finishedAt,
        Long durationMs,
        String error,
        List<UnexpectedCallEntry> unexpectedCalls,
        RequestChangedEntry requestChanged,
        List<PauseEntry> pauses,
        JsonNode editsApplied
) {
}
