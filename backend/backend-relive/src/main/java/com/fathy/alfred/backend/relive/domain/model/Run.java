package com.fathy.alfred.backend.relive.domain.model;

import java.util.List;

/**
 * One execution of a saved (or transient) cycle. {@code definition} is the full snapshot of the
 * cycle as it was run (FR-044/045) - later edits to the cycle never change a past run's view of
 * itself.
 */
public record Run(
        String id,
        String cycleId,
        String driver,
        RunStatus status,
        String startedAt,
        String finishedAt,
        ReliveCycle definition,
        String fromStepKey,
        List<VariableChange> seedVariables,
        List<VariableChange> variableTimeline,
        RunSummary summary,
        Hold hold,
        List<Resumed> resumed,
        List<LogEntry> log
) {
}
