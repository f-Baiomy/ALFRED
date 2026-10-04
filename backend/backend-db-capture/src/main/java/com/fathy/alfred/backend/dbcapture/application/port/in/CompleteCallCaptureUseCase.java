package com.fathy.alfred.backend.dbcapture.application.port.in;

/**
 * The inbound call a set of statements belongs to has completed: failures it returned success over are "swallowed",
 * and a call that came back as a transport error while its capture was still open ended early (the application
 * died mid-call - the agent could not say so itself).
 */
public interface CompleteCallCaptureUseCase {

    void callCompleted(String callId, Integer status, String error);
}
