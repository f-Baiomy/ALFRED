package com.fathy.alfred.backend.relive.domain.model;

/** Rolled-up counts shown on the cycles list and the run header. */
public record RunSummary(
        int total,
        int completed,
        int different,
        int failed,
        int skipped,
        int notCalled,
        int cancelled,
        int live,
        int replayed,
        int unattributed
) {
}
