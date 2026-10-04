package com.fathy.alfred.backend.dbcapture.domain.model;

/** A group of statements committed or rolled back together. {@code outcome}: COMMITTED, ROLLED_BACK or OPEN. */
public record StatementTransaction(String callId, String txId, String connectionId, int firstSeq, int lastSeq,
                                   String outcome, long heldMicros, int statementCount, int writeCount) {

    public static final String COMMITTED = "COMMITTED";
    public static final String ROLLED_BACK = "ROLLED_BACK";
    public static final String OPEN = "OPEN";
}
