package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * What the ◆ DB chip on a call card reads - one per call the agent tracked (created by its CALL_OPEN marker), so a
 * summary with zero statements means "captured, nothing ran" and no summary means "not captured".
 * {@code complete} is set when the inbound call's completion is observed; {@code endedEarly} when that completion
 * came back as an error with the summary still open (the application died mid-call).
 */
public record CallDbSummary(
        String callId,
        int statementCount,
        int writeCount,
        int deleteCount,
        int failedCount,
        int transactionCount,
        int rolledBackCount,
        long dbMicros,
        long droppedCount,
        List<DbFlag> flags,
        int lastSeq,
        boolean complete,
        boolean endedEarly
) {
}
