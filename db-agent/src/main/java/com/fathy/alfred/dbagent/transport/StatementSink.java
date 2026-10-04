package com.fathy.alfred.dbagent.transport;

/** Where captured records go - the BatchSender in the agent, a list in the tests. Must never block or throw. */
public interface StatementSink {

    void statement(StatementRecord record);

    void marker(MarkerRecord marker);
}
