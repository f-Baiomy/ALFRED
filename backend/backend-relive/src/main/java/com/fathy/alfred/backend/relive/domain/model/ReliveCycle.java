package com.fathy.alfred.backend.relive.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/**
 * A saved (or transient, "Relive now") replay workflow (data-model.md "ReliveCycle"). The field
 * is named {@code isTransient} because {@code transient} is a reserved Java keyword; it is
 * serialised over the wire as {@code transient} via {@link JsonProperty}.
 *
 * <p>{@code fingerprintIndex} is parent step key → request hash → outbound candidate step keys,
 * in cycle order. It is derived from stored hashes when the cycle is configured, never from a
 * client and never while a run is starting. Null means the map was never stored; publish leaves
 * it off the snapshot so the proxy keeps the older scan for that run.
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
        RunSummary lastRun,
        Map<String, Map<String, List<String>>> fingerprintIndex
) {
    /** Cycles and tests written before the index existed leave it null. */
    public ReliveCycle(
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
            boolean isTransient,
            RunSummary lastRun) {
        this(id, name, description, steps, variables, cycleRules, globalRules, settings, noise,
                unexpectedCalls, createdAt, updatedAt, isTransient, lastRun, null);
    }

    public ReliveCycle withTransient(boolean value, String newUpdatedAt) {
        return new ReliveCycle(id, name, description, steps, variables, cycleRules, globalRules, settings, noise,
                unexpectedCalls, createdAt, newUpdatedAt, value, lastRun, fingerprintIndex);
    }

    public ReliveCycle withSteps(List<Step> newSteps, Map<String, Map<String, List<String>>> newIndex) {
        return new ReliveCycle(id, name, description, newSteps, variables, cycleRules, globalRules, settings, noise,
                unexpectedCalls, createdAt, updatedAt, isTransient, lastRun, newIndex);
    }
}
