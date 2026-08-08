package com.alfred.pennyworth.calls.application.port.out;

import com.alfred.pennyworth.calls.domain.model.CallRecord;

import java.util.List;

/** Outbound port: how the application core fans out "a new call arrived" - today, a WebSocket broadcast. */
public interface CallNotificationPort {

    void notifyNewCall(CallRecord call, List<String> capturedByCycleIds);
}
