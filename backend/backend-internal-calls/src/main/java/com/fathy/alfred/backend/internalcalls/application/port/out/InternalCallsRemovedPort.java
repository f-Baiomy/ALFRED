package com.fathy.alfred.backend.internalcalls.application.port.out;

import java.util.Collection;

/**
 * Told after inbound calls are deleted - by the retention limits, a clean-up, a Relive run's history or "clear all".
 * Everything captured with a call (its database statements, Redis commands, caught log lines, triage mark) belongs to
 * it and must go with it; backend-app's deletion cascade implements this so this slice never names those slices.
 * Called after the delete committed, never inside its transaction.
 */
public interface InternalCallsRemovedPort {

    /** Also after "clear all", with every id that was cleared. */
    void callsRemoved(Collection<String> callIds);
}
