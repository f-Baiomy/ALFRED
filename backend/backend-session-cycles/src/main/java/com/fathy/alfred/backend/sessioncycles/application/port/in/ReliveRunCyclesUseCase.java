package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.ReliveRunCycle;

import java.util.Collection;
import java.util.Optional;

/** Inbound port: the session cycle each Relive run keeps its calls in (SessionCycle.reliveRunId). */
public interface ReliveRunCyclesUseCase {

    /** The run's cycle, created when missing and then filled with every call of the run still in
     *  the call logs (a run from before run cycles existed). {@code name}/{@code reliveCycleId}
     *  update it when given. */
    ReliveRunCycle open(String runId, String name, String reliveCycleId);

    /** The id of the cycle a call of this run is captured into - created empty when missing. */
    String captureCycleId(String runId);

    Optional<String> cycleIdOf(String runId);

    /** Deletes the cycles of these runs, with everything they captured. Returns how many. */
    int deleteForRuns(Collection<String> runIds);
}
