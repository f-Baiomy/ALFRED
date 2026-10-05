package com.fathy.alfred.backend.dbcapture.application.port.out;

/**
 * Told whenever a call's failed-statement counts may have changed: after each ingested batch that gave a call a failed
 * statement, and when the call completes (that is when "swallowed" is decided). Implemented in backend-app, where
 * triage keeps its own indexed mark per call; this slice knows nothing of who listens.
 */
public interface StatementFailuresObserverPort {

    void failuresChanged(String callId, int failedCount, int swallowedCount);
}
