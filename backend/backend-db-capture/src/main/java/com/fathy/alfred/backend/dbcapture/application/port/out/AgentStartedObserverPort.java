package com.fathy.alfred.backend.dbcapture.application.port.out;

import java.time.Instant;

/**
 * A new agent process reported for the first time - the project's application (re)started, so a new build may be
 * running (the task board's "ready to re-test", specs/016). Implemented outside this slice; optional.
 */
public interface AgentStartedObserverPort {

    void agentStarted(String project, Instant at);
}
