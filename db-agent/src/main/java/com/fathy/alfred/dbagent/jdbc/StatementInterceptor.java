package com.fathy.alfred.dbagent.jdbc;

/**
 * The one seam between "a statement is about to run" and the database (FR-042). Today there is a single
 * implementation, {@link CaptureOnlyInterceptor}, and it always lets the statement run.
 *
 * <p>The later Relive feature adds implementations whose {@link #before} can answer a statement from the recording
 * ({@code AnswerWith(result)}), make it fail with a chosen error ({@code Fail(sqlException)}), or hold it until the user
 * decides ({@code Await(decision)}) - without touching how capture works. Those outcomes, and the advice support for
 * skipping the real call, are deliberately not built yet.
 */
public interface StatementInterceptor {

    enum Decision {
        PROCEED
    }

    /** Called before a captured statement executes, with its call id (null outside a call), sequence and SQL. */
    Decision before(String callId, String runTag, int seq, String sql);
}
