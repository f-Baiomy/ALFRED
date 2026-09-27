package com.fathy.alfred.backend.scenarios.domain.model;

/**
 * The list shape of a Run - everything except {@code results} (up to the 20 MB cap, never needed
 * to render a run history row). Same summary/detail split as ScenarioSummary/Scenario.
 */
public record RunListItem(
        String id,
        String scenarioId,
        String startedAt,
        String finishedAt,
        RunOutcome summary
) {
}
