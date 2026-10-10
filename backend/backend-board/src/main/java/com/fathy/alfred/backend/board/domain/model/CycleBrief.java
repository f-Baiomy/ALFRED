package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** What a session cycle is for: Markdown with mentions. Empty text when none was written. */
public record CycleBrief(String cycleId, String text, Instant updatedAt) {
}
