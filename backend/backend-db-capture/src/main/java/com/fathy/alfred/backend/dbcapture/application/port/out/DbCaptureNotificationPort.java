package com.fathy.alfred.backend.dbcapture.application.port.out;

/** "Something changed" signals for /ws/db-capture - ids and counts only, never statement content. */
public interface DbCaptureNotificationPort {
    void statementsAppended(String callId, int lastSeq, boolean summaryChanged);

    void outsideAppended(String thread, int count);

    void captureSettingsChanged(String project);

    void agentStatusChanged(String project, boolean attached);
}
