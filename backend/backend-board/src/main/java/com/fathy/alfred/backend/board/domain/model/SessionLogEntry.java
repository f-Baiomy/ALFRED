package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** One skill run Claude logged on a cycle (specs/015 FR-12): which skill, what it did, found, and what comes next. */
public record SessionLogEntry(long id, String cycleId, String skill, String did, String found, String next, Instant at) {
}
