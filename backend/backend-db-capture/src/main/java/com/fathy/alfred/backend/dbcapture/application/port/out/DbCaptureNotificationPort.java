package com.fathy.alfred.backend.dbcapture.application.port.out;

/** "Something changed" signals for /ws/db-capture - ids and counts only, never statement content. */
public interface DbCaptureNotificationPort {
    void statementsAppended(String callId, int lastSeq, boolean summaryChanged);

    void outsideAppended(String thread, int count);

    /** Caught log lines arrived for a call (null = outside any call) of a project (specs/009-agent-log-capture). */
    default void logsAppended(String callId, String project) {
    }

    /** Redis commands of these calls were stored, or their summary changed (specs/011-redis-capture). */
    default void storeCommandsAppended(java.util.Collection<String> callIds) {
    }

    void captureSettingsChanged(String project);

    void agentStatusChanged(String project, boolean attached);
}
