package com.fathy.alfred.backend.dbcapture.application.port.in;

import java.util.Collection;

/** Removes the captured statements of calls that were deleted or cleared - they belong to their call (FR-038). */
public interface DeleteCallStatementsUseCase {
    int deleteForCalls(Collection<String> callIds);

    /** Every call's statements - "clear all calls". Outside-call statements are kept: they belong to no call. */
    void deleteAllCallStatements();
}
