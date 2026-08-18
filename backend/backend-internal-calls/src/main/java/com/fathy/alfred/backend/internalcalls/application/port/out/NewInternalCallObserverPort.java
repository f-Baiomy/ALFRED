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

    /** Fired only on completion (this slice has no two-phase capture concept) - a recording session-cycle decides fresh at this point whether to capture the call, exactly like backend-calls' file-mode adapter does. @return ids of every session-cycle that captured this call. */
    List<String> onCallCompleted(CallRecord call);
}
