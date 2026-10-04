package com.fathy.alfred.dbagent.jdbc;

/** Records, never interferes - see {@link StatementInterceptor}. */
public final class CaptureOnlyInterceptor implements StatementInterceptor {

    @Override
    public Decision before(String callId, String runTag, int seq, String sql) {
        return Decision.PROCEED;
    }
}
