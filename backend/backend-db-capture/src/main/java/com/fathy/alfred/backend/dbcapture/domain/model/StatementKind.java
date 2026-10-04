package com.fathy.alfred.backend.dbcapture.domain.model;

/** What a captured statement did - decided by the agent from the SQL text (and by JDBC for COMMIT/ROLLBACK). */
public enum StatementKind {
    SELECT, INSERT, UPDATE, DELETE, MERGE, CALL, DDL, OTHER,
    COMMIT, ROLLBACK, SAVEPOINT, ROLLBACK_TO_SAVEPOINT;

    /** Changes data - what the "writes" count and the Writes filter mean. */
    public boolean isWrite() {
        return this == INSERT || this == UPDATE || this == DELETE || this == MERGE;
    }

    /** Ends (or partly ends) a transaction rather than touching data. */
    public boolean isTransactionEnd() {
        return this == COMMIT || this == ROLLBACK || this == ROLLBACK_TO_SAVEPOINT;
    }
}
