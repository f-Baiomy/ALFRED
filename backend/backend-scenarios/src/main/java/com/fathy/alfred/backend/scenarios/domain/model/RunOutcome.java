package com.fathy.alfred.backend.scenarios.domain.model;

/**
 * Pass/fail tally for one run - both the standalone {@code summary} field on a Run and the
 * {@code lastRun} field embedded in a Scenario (contracts/002-power-features section 3). Reused
 * directly on the web boundary (no separate DTO) since the wire shape matches exactly - see the
 * DTO-vs-domain-reuse rule in CLAUDE.md.
 */
public record RunOutcome(
        int total,
        int passed,
        int failed,
        int errored
) {
}
