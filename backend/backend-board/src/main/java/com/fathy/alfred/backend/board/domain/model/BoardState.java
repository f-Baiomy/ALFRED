package com.fathy.alfred.backend.board.domain.model;

/**
 * A board's state (specs/027 FR-001a), set only by the user. DONE and ARCHIVED boards keep everything but judge no new
 * calls and receive no new findings; ARCHIVED ones are also hidden from the picker. A default board stays OPEN.
 */
public enum BoardState {
    OPEN,
    DONE,
    ARCHIVED
}
