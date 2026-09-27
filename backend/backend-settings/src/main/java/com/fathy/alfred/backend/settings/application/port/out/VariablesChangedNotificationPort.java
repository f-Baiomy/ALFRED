package com.fathy.alfred.backend.settings.application.port.out;

/** Outbound port: how the application core fans out "the shared variables changed" - today, a WebSocket broadcast. */
public interface VariablesChangedNotificationPort {

    /**
     * Fired after every change to the shared variables, however it arrived (UI save, proxy
     * promotion): no payload, dashboards just refetch GET /settings/variables. Payload-free
     * deliberately - the state is one small object and a refetch cannot disagree with the
     * sender about what changed, the way an event carrying a stale copy could.
     */
    void notifyVariablesChanged();
}
