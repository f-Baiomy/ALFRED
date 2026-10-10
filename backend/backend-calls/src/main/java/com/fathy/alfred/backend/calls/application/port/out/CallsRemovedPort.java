package com.fathy.alfred.backend.calls.application.port.out;

import java.util.Collection;

/**
 * Told after outbound calls are deleted (the size or row limit, a clean-up, "clear all"), so what belongs to a call -
 * its triage mark - goes with it. backend-app's deletion cascade implements it; this slice never names that slice.
 * Called after the delete committed.
 */
public interface CallsRemovedPort {

    /** Also after "clear all", with every id that was cleared. */
    void callsRemoved(Collection<String> callIds);
}
