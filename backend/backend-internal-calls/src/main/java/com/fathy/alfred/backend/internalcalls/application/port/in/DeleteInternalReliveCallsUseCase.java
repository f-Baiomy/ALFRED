package com.fathy.alfred.backend.internalcalls.application.port.in;

import java.util.Collection;

/** Inbound port: removing logged inbound calls by their Relive attribution. The Relive history
 *  delete's "also delete the related calls" choice reaches this log only through here -
 *  backend-relive itself never depends on this slice (ArchUnit isolation; backend-app's
 *  relivebridge calls this). */
public interface DeleteInternalReliveCallsUseCase {

    /** Deletes every logged call attributed to any of the given run ids - attributed normally
     *  ({@code relive.runId}) or blocked as AMBIGUOUS for the run ({@code relive.ambiguousRunIds}).
     *  Returns how many calls were removed. */
    int deleteByRunIds(Collection<String> runIds);
}
