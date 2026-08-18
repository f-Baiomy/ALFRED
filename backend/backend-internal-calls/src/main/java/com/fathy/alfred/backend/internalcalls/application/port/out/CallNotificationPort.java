package com.fathy.alfred.backend.internalcalls.application.port.out;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;

import java.util.List;

/** Outbound port: how the application core fans out "a new internal call arrived" - today, a WebSocket broadcast. */
public interface CallNotificationPort {

    /** Two-phase logging, first half - {@code call.state()} is IN_PROGRESS, no response yet. Pushed so the dashboard can show an in-progress card the instant the proxy intercepts the request. Nothing is ever captured into a session-cycle at prepare time for this slice, so there are no cycleIds to report here. */
    void notifyCallPrepared(CallRecord call);

    /** Two-phase logging, second half - {@code call} now carries its outcome (state COMPLETED or ERROR). Same wire shape/channel as {@link #notifyCallPrepared}, so the frontend updates the existing in-progress card in place rather than treating this as a different kind of event. {@code capturedByCycleIds} lists every RECORDING session-cycle that captured this call (see NewInternalCallObserverPort), empty if none. */
    void notifyCallCompleted(CallRecord call, List<String> capturedByCycleIds);

    /** Fired after every logged call is deleted at once - no payload, callers just refetch GET /internal-calls. */
    void notifyCallsCleared();
}
