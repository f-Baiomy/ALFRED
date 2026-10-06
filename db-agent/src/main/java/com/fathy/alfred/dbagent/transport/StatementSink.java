package com.fathy.alfred.dbagent.transport;

/** Where captured records go - the BatchSender in the agent, a list in the tests. Must never block or throw. */
public interface StatementSink {

    void statement(StatementRecord record);

    void marker(MarkerRecord marker);

    /** A caught log line (specs/009-agent-log-capture). */
    default void log(LogRecord record) {
    }

    /** Lines of a call that were not kept (caps, late) - counted, sent with the next batch. */
    default void droppedLogs(String callId, int count) {
    }
}
