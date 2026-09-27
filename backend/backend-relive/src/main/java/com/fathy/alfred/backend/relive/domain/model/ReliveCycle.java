package com.fathy.alfred.backend.relive.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * A saved (or transient, "Relive now") replay workflow (data-model.md "ReliveCycle"). The field
 * is named {@code isTransient} because {@code transient} is a reserved Java keyword; it is
 * serialised over the wire as {@code transient} via {@link JsonProperty}.
 */
public record ReliveCycle(
        String id,
        String name,
        String description,
        List<Step> steps,
        List<CycleVariable> variables,
        List<CycleRule> cycleRules,
        GlobalRulesSelection globalRules,
        ReliveSettings settings,
        List<NoiseRule> noise,
        UnexpectedCallsPolicy unexpectedCalls,
        String createdAt,
        String updatedAt,
        @JsonProperty("transient") boolean isTransient,
        RunSummary lastRun
) {
}
