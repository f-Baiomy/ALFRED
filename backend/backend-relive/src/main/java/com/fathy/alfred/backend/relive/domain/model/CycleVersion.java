package com.fathy.alfred.backend.relive.domain.model;

/** A prior saved definition, for undo (FR-007c). Newest 10 kept per cycle; not run history. */
public record CycleVersion(String cycleId, int version, String savedAt, String reason, ReliveCycle definition) {
}
