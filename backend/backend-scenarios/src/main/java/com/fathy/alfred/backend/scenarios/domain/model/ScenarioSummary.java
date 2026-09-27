package com.fathy.alfred.backend.scenarios.domain.model;

/**
 * The list shape of a Scenario - everything except {@code definition}, which routinely runs
 * large (up to the 20 MB cap) and is never needed to render a scenario list row. Same
 * summary/detail split as backend-calls' CallSummary/CallDetail (see docs/architecture.md).
 */
public record ScenarioSummary(
        String id,
        String name,
        String description,
        String createdAt,
        String updatedAt,
        RunOutcome lastRun
) {
}
