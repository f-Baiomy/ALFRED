package com.fathy.alfred.backend.dbcapture.domain.model;

/** A captured call that ran on a given request thread, and when it opened (its CALL_OPEN marker's time, ISO). */
public record CallOnThread(String callId, String openedAt) {
}
