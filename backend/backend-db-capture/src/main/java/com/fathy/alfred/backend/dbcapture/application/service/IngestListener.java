package com.fathy.alfred.backend.dbcapture.application.service;

/**
 * Work that follows a stored batch inside this slice - flag computation (per call) and the size cap (per batch).
 * Collected by DbCaptureService through constructor injection, so each concern lives in its own class.
 */
public interface IngestListener {

    /** A call's statements and summary were just updated. */
    default void callIngested(String callId) {
    }

    /** A whole batch was stored. */
    default void batchIngested() {
    }
}
