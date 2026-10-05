package com.fathy.alfred.backend.dbcapture.domain.model;

/** The kinds of problem the database window flags (FR-023) - computed by StatementFlags. */
public enum DbFlagType {
    FAILED_SWALLOWED, FAILED, ROLLED_BACK, NO_WHERE, LARGE_DELETE, REPEATED_QUERY, SLOW, HUGE_RESULT,
    LOCK_DURING_SUPPLIER_CALL, CASCADE, BEFORE_NOT_CAPTURED,
    /** The same statement with the same parameters more than once in one call - a cache-per-request fix, not batching. */
    DUPLICATE,
    /** About as many transactions as statements - every statement pays connection checkout, begin and commit. */
    TX_PER_STATEMENT,
    /**
     * One query whose returned rows each triggered more queries - an N+1 inside one statement execution (Hibernate
     * loading a collection per row, one query each). Found by the HQL origin, or by the per-row pattern in plain JDBC.
     */
    QUERY_FAN_OUT
}
