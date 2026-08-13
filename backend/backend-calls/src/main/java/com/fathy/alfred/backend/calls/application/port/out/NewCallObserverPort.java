package com.fathy.alfred.backend.calls.application.port.out;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.List;

/**
 * Outbound port: lets other slices react to a newly-received call without backend-calls
 * knowing they exist. Spring injects the list of every implementing bean (empty if none are on
 * the classpath), so CallsService works unchanged whether or not anything implements this.
 */
public interface NewCallObserverPort {

    /** Legacy single-shot path (POST /calls/webhook) - call arrives already fully resolved; capture it in one shot exactly as before two-phase logging existed. @return the ids of whatever this observer captured the call into (e.g. recording session-cycles), or an empty list. */
    List<String> onNewCall(CallRecord call);

    /** Two-phase logging, first half - the call was just intercepted, not yet resolved (state IN_PROGRESS). @return the ids captured into, same contract as {@link #onNewCall}. */
    List<String> onCallPrepared(CallRecord call);

    /** Two-phase logging, second half - fills in the outcome of a previously-{@link #onCallPrepared} call, in whichever cycles captured it (regardless of whether they're still recording now). @return the ids updated. */
    List<String> onCallCompleted(CallRecord call);
}
