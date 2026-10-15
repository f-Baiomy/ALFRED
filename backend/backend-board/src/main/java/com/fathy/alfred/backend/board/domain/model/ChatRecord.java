package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * Something the chat's Claude wrote to the board without being asked (specs/022 FR-048, FR-049): a decision in the brief,
 * an Inbox card, a proposed acceptance item, a fix report with its re-test plan, or a Next in the brief. {@code line} is
 * what the chat shows ("recorded the decision ... in the brief"); {@code undo} holds what Undo needs to reverse it.
 */
public record ChatRecord(long id, long messageId, Kind kind, String target, String line, String undo, Instant createdAt, Instant undoneAt) {

    public enum Kind { DECISION, CARD, ITEM, FIX, NEXT }

    public boolean undone() {
        return undoneAt != null;
    }
}
