package com.fathy.alfred.backend.relive.application.port.in;

import java.util.Collection;

/** Inbound port: bulk stops from the History tab - {@link StopRunUseCase}'s drain-safe stop,
 *  applied to many runs at once. */
public interface StopRunsUseCase {

    /** Stops every RUNNING run of one cycle at once; runs already settled elsewhere are skipped.
     *  Returns how many runs were stopped. */
    int stopAllRunning(String cycleId);

    /** Stops the given runs of one cycle - only those still RUNNING, and only if they belong to
     *  this cycle. Returns how many were stopped. */
    int stopSelected(String cycleId, Collection<String> runIds);
}
