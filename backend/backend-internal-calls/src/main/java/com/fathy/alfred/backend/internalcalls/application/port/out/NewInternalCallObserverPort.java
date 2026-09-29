package com.fathy.alfred.backend.internalcalls.application.port.out;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;

import java.util.List;

/**
 * Outbound port: lets other slices react to a completed internal call without backend-internal-calls
 * knowing they exist. Spring injects the list of every implementing bean (empty if none are on the
 * classpath), so InternalCallsService works unchanged whether or not anything implements this -
 * mirrors backend-calls' own NewCallObserverPort, trimmed to this slice's simpler scope.
 */
public interface NewInternalCallObserverPort {

    /**
     * Fired after the request is persisted but before the reverse proxy forwards it upstream.
     * Implementations that only need a completed response can ignore this phase.
     */
    default void onCallPrepared(CallRecord call) {
        // Completion-only observers retain their existing behaviour.
    }

    /** A recording session-cycle decides fresh on completion whether to capture the call. @return ids of every session-cycle that captured this call. */
    List<String> onCallCompleted(CallRecord call);
}
