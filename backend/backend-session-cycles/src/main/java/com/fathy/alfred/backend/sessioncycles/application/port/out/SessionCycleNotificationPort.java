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

    /**
     * One cycle's contents changed - its captured calls (cleared, removed, copied or imported in) or its
     * spacers - by anyone, from any page or window. Live capture is not signalled here: each captured
     * call already arrives on the calls sockets. Carries the cycle id so a view showing another cycle
     * ignores it (the session-cycle widget, possibly in its own window, reloads only its own cycle).
     */
    default void notifyCycleContentChanged(String cycleId) {
    }
}
