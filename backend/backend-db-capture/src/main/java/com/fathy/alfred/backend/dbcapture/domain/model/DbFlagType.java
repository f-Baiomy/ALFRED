package com.fathy.alfred.backend.dbcapture.domain.model;

/** The kinds of problem the database window flags (FR-023) - computed by StatementFlags. */
public enum DbFlagType {
    FAILED_SWALLOWED, FAILED, ROLLED_BACK, NO_WHERE, LARGE_DELETE, REPEATED_QUERY, SLOW, HUGE_RESULT,
    LOCK_DURING_SUPPLIER_CALL, CASCADE, BEFORE_NOT_CAPTURED
}
