package com.fathy.alfred.backend.relive.adapter.out.websocket;

/** Notified when a WebSocket session claims or releases a run's lease (research D1). Implemented
 *  by RunLeaseRegistry (T047); kept as its own interface here so this adapter-out package doesn't
 *  need to depend on application.service. */
public interface LeaseListener {

    void onLeaseHeld(String runId, String sessionId);

    void onSessionClosed(String sessionId);

    /** The tab stopped driving the run on purpose (it finished, stopped, or the page moved on). */
    void onLeaseReleased(String runId, String sessionId);
}
