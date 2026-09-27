package com.fathy.alfred.backend.scenarios.application.port.out;

/**
 * Outbound port: how the application core fans out "scenarios or their runs changed" - today, a
 * WebSocket broadcast. Carries no payload (same rationale as backend-profiles'
 * ProfileNotificationPort) - the frontend refetches the (cheap) list on this signal.
 */
public interface ScenarioNotificationPort {

    void notifyScenariosChanged();
}
