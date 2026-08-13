package com.fathy.alfred.backend.calls.application.port.out;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.List;

/** Outbound port: how the application core fans out "a new call arrived" - today, a WebSocket broadcast. */
public interface CallNotificationPort {

    void notifyNewCall(CallRecord call, List<String> capturedByCycleIds);

    /** Fired after every logged call is deleted at once (the Database settings tab's "Clear calls" action) - no payload, callers just refetch GET /calls, same as SessionCycleNotificationPort.notifySessionCyclesChanged(). */
    void notifyCallsCleared();
}
