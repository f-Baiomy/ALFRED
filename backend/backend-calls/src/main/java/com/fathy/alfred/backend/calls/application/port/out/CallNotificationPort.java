package com.fathy.alfred.backend.calls.application.port.out;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.List;

/** Outbound port: how the application core fans out "a new call arrived" - today, a WebSocket broadcast. */
public interface CallNotificationPort {

    void notifyNewCall(CallRecord call, List<String> capturedByCycleIds);
}
