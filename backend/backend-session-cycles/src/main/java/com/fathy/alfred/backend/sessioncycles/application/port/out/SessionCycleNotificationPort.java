package com.fathy.alfred.backend.sessioncycles.application.port.out;

/**
 * Outbound port: how the application core fans out "the session-cycle list changed" - today, a
 * WebSocket broadcast. Deliberately carries no payload - unlike a new call (which the dashboard
 * wants to render the instant it arrives), a cycle create/rename/record/pause/delete is rare and
 * the whole list is cheap to refetch, so the frontend just re-fetches GET /session-cycles on this
 * signal instead of maintaining a second merge/dedupe pipeline for cycle metadata.
 */
public interface SessionCycleNotificationPort {

    void notifySessionCyclesChanged();
}
