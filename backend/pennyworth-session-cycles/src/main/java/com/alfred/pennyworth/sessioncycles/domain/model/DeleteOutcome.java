package com.alfred.pennyworth.sessioncycles.domain.model;

/** Result of trying to delete a session-cycle - distinct outcomes so the controller can map to 404 vs 409 instead of always answering the same way. */
public enum DeleteOutcome {
    DELETED,
    NOT_FOUND,
    BLOCKED_RECORDING
}
