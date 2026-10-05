package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * The failed statements of one call, read from the failed-statement index - what triage shows as the evidence for a
 * call. {@code statements} holds at most {@link #MAX_PER_CALL}; the counts are always the full ones.
 */
public record CallStatementFailures(String callId, int failedCount, int swallowedCount, List<FailedStatement> statements) {

    public static final int MAX_PER_CALL = 50;

    /** One failed statement, without its parameters or rows (the statement detail reads those). */
    public record FailedStatement(long id, int seq, StatementKind kind, String table, String sql, String sqlState, Integer vendorCode,
                                  String message, boolean swallowed, boolean undone, long durationMicros, String codeLocation,
                                  List<String> callers) {

        public static FailedStatement of(CapturedStatement s) {
            StatementOutcome o = s.outcome();
            return new FailedStatement(s.id(), s.seq(), s.kind(), s.table(), s.sql(), o == null ? null : o.sqlState(),
                    o == null ? null : o.vendorCode(), o == null ? null : o.message(), o != null && Boolean.TRUE.equals(o.swallowed()),
                    s.undone(), s.durationMicros(), s.codeLocation(), s.callers());
        }
    }
}
