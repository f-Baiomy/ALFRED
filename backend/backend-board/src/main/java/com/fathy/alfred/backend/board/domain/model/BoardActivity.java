package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A board-level event (specs/027 data-model): a cycle or board related or unrelated, a card's home moved in or out, the
 * state changed, the board created or migrated, a kept cycle made. {@code undo} is set for Claude's reversible changes;
 * {@code undoneAt} once the user pressed Undo.
 */
public record BoardActivity(long id, String boardId, Actor actor, Kind kind, String text, Undo undo, Instant at, Instant undoneAt) {

    public enum Kind { CREATED, MIGRATED, RENAMED, STATE, RELATE_CYCLE, UNRELATE_CYCLE, RELATE_BOARD, UNRELATE_BOARD, MOVE_HOME_IN,
        MOVE_HOME_OUT, KEPT_CYCLE }

    /** How to reverse the change: relate/unrelate a cycle or a board, or move a card's home back. */
    public record Undo(Kind kind, String boardId, String otherId, String cardId) {
    }
}
