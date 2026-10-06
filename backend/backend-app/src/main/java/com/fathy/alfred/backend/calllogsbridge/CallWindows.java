package com.fathy.alfred.backend.calllogsbridge;

import java.util.List;

/**
 * The time-and-thread matching rule (specs/008-logs-call-link FR-002, FR-004): a line of the call's request thread
 * belongs to it when its time falls in the call's window widened by the clock difference - unless a neighbouring call
 * on the same thread also contains it and the line is nearer that call's window middle. Pure, so it is tested directly.
 */
final class CallWindows {

    private CallWindows() {
    }

    /** A call's window in epoch ms (UTC), not yet widened. */
    record Window(String callId, long startMs, long endMs) {
        double middle() {
            return (startMs + endMs) / 2.0;
        }

        boolean contains(long atMs, long skewMs) {
            return atMs >= startMs - skewMs && atMs <= endMs + skewMs;
        }
    }

    /** Whether a line at {@code atMs} belongs to {@code self} given the neighbours on the same thread. */
    static boolean belongsTo(Window self, List<Window> neighbours, long atMs, long skewMs) {
        if (!self.contains(atMs, skewMs)) {
            return false;
        }
        double mine = Math.abs(atMs - self.middle());
        for (Window other : neighbours) {
            if (!other.callId().equals(self.callId()) && other.contains(atMs, skewMs) && Math.abs(atMs - other.middle()) < mine) {
                return false;
            }
        }
        return true;
    }
}
