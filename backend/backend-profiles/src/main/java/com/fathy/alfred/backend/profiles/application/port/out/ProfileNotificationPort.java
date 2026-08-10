package com.fathy.alfred.backend.profiles.application.port.out;

/**
 * Outbound port: how the application core fans out "the profile list changed" - today, a
 * WebSocket broadcast. Carries no payload for the same reason as session-cycles'
 * SessionCycleNotificationPort: profile changes are rare and the whole list is cheap to refetch.
 */
public interface ProfileNotificationPort {

    void notifyProfilesChanged();
}
