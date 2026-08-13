package com.fathy.alfred.backend.calls.application.port.out;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.List;

/** Outbound port: how the application core fans out "a new call arrived" - today, a WebSocket broadcast. */
public interface CallNotificationPort {

    /** The legacy single-shot path (POST /calls/webhook) - a call arrived already fully resolved. */
    void notifyNewCall(CallRecord call, List<String> capturedByCycleIds);

    /** Two-phase logging, first half - {@code call.state()} is IN_PROGRESS, no response yet. Pushed so the dashboard can show an in-progress card the instant the proxy intercepts the request; {@code capturedByCycleIds} lets an open session-cycle detail page do the same. */
    void notifyCallPrepared(CallRecord call, List<String> capturedByCycleIds);

    /** Two-phase logging, second half - {@code call} now carries its outcome (state COMPLETED or ERROR). Same wire shape/channel as {@link #notifyNewCall}, so the frontend updates the existing in-progress card in place rather than treating this as a different kind of event. */
    void notifyCallCompleted(CallRecord call, List<String> capturedByCycleIds);

    /** Fired after every logged call is deleted at once (the Database settings tab's "Clear calls" action) - no payload, callers just refetch GET /calls, same as SessionCycleNotificationPort.notifySessionCyclesChanged(). */
    void notifyCallsCleared();
}
