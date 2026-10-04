package com.fathy.alfred.backend.dbcapture.domain.model;

/** Which shape a {@link StatementOutcome} has - see that record. */
public enum OutcomeKind {
    ROWS, UPDATED, PROCEDURE, FAILED, TX_END
}
