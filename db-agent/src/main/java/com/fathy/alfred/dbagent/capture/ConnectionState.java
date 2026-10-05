package com.fathy.alfred.dbagent.capture;

/**
 * Transaction bookkeeping per connection. Auto-commit is assumed on until the application (or its pool) says
 * otherwise - for a connection opened before the agent attached that can be wrong until the next setAutoCommit,
 * which only means its statements show without a transaction.
 */
final class ConnectionState {

    final String id;
    volatile boolean autoCommit = true;
    volatile String txId;
    volatile long txStartNanos;
    volatile CallContext txContext;
    volatile String dataSource;
    /** Checkout time not yet reported - the next statement on this connection carries it. */
    volatile Long pendingAcquireMicros;
    /** setAutoCommit(false) and close() durations of the current transaction, reported on its TX_END line. */
    volatile Long beginMicros;
    volatile Long closeMicros;

    ConnectionState(String id) {
        this.id = id;
    }
}
