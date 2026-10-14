package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A picture pasted or dropped into a board text (docs/board.md "Rich text"), stored in Alfred - never loaded from
 * elsewhere. It belongs to the card (or cycle) whose text first shows it, and goes with that card; one never shown is
 * removed after a day.
 */
public record BoardImage(String id, String mime, byte[] data, String cardId, String cycleId, Instant createdAt) {

    public static final int MAX_BYTES = 5 * 1024 * 1024;
}
