package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * A group of statements committed or rolled back together. {@code outcome}: COMMITTED, ROLLED_BACK or OPEN.
 * {@code lifecycle}: checkout/begin/commit/close timings and JDBC-or-JTA, when the agent observed them.
 */
public record StatementTransaction(String callId, String txId, String connectionId, int firstSeq, int lastSeq,
                                   String outcome, long heldMicros, int statementCount, int writeCount, TxLifecycle lifecycle) {

    public StatementTransaction(String callId, String txId, String connectionId, int firstSeq, int lastSeq,
                                String outcome, long heldMicros, int statementCount, int writeCount) {
        this(callId, txId, connectionId, firstSeq, lastSeq, outcome, heldMicros, statementCount, writeCount, null);
    }

    public static final String COMMITTED = "COMMITTED";
    public static final String ROLLED_BACK = "ROLLED_BACK";
    public static final String OPEN = "OPEN";
}
