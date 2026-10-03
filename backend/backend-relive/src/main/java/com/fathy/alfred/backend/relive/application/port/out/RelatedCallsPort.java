package com.fathy.alfred.backend.relive.application.port.out;

import java.util.Collection;

/** Outbound port: the logged calls (outbound and inbound) that belong to runs, identified by the
 *  relive attribution ALFRED's proxies attach to every call. Implemented in backend-app's
 *  relivebridge, which fans out into both call slices - backend-relive never depends on them
 *  directly (ArchUnit slice isolation). */
public interface RelatedCallsPort {

    /** Deletes every logged call attributed to any of the given run ids - attributed normally
     *  ({@code relive.runId}) or only ever blocked as AMBIGUOUS for the run
     *  ({@code relive.ambiguousRunIds}). Returns how many calls were removed. */
    int deleteByRunIds(Collection<String> runIds);

    /** Deletes the session cycles these runs kept their calls in (one per run, opened from the
     *  run's History). Called whenever runs are deleted - by the user, by the run-count limit, or
     *  with their Relive cycle - since a run cycle belongs to its run and is listed nowhere else. */
    default int deleteRunCycles(Collection<String> runIds) {
        return 0;
    }
}
