package com.fathy.alfred.backend.dbcapture.application.port.in;

import java.util.Collection;

/** Removes the captured statements of calls that were deleted or cleared - they belong to their call (FR-038). */
public interface DeleteCallStatementsUseCase {
    int deleteForCalls(Collection<String> callIds);

    /**
     * These inbound calls were deleted from the live list: their captures go with them - except a call a session cycle
     * holds (the cycle shows it, with its statements, until the cycle is deleted) and a call with Relive-run statements
     * (they go with the run's history).
     */
    int callsDeleted(Collection<String> callIds);

    /** Every call's statements - "clear all calls". Outside-call statements are kept: they belong to no call. */
    void deleteAllCallStatements();

    /** The statements of Relive runs whose history is deleted (their run tag names the run). */
    int deleteForRuns(Collection<String> runIds);
}
