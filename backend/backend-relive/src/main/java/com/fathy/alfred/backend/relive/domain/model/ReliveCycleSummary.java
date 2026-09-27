package com.fathy.alfred.backend.relive.domain.model;

/**
 * The cycles list row - headers only, no {@code steps}/{@code variables}/{@code cycleRules}
 * bodies (constitution II: a list must not cost reading every definition). {@code stepCount} and
 * {@code liveCount} are maintained as their own columns precisely so this query never has to
 * parse {@code definition_json} (see SqliteReliveRepository / T010).
 */
public record ReliveCycleSummary(
        String id,
        String name,
        String description,
        int stepCount,
        int liveCount,
        RunSummary lastRun,
        String createdAt,
        String updatedAt,
        boolean isTransient
) {
}
