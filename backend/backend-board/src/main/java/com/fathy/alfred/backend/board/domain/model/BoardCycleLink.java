package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * What a board keeps about one of its cycles (specs/033): what it recorded the cycle for ({@code REC} / {@code RETEST},
 * null for a cycle related by hand or before specs/033), whether it is the board's ⚑ baseline (one per board), and
 * whether the board archived it (hidden from the list, everything kept). These are the board's choices, not the cycle's:
 * the same cycle on two boards may be one's baseline and archived on the other.
 */
public record BoardCycleLink(String cycleId, String kind, boolean baseline, boolean archived, Instant relatedAt) {
}
