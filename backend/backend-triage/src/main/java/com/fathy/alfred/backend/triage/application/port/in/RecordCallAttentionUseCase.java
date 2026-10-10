package com.fathy.alfred.backend.triage.application.port.in;

import com.fathy.alfred.backend.triage.domain.model.CallSignals;
import com.fathy.alfred.backend.triage.domain.model.ObservedCall;

/**
 * What backend-app/triagebridge reports as calls happen. Each method returns at once; the mark is written in order on
 * this slice's own writer thread, so a webhook is never slowed down by reading a body or by triage's database.
 */
public interface RecordCallAttentionUseCase {

    /** A call was intercepted (state IN_PROGRESS) or completed (COMPLETED / ERROR, with its response body). */
    void callObserved(ObservedCall call);

    /** A call's failed / swallowed database statement counts, as db-capture now has them. */
    void statementFailures(String callId, int failedCount, int swallowedCount);

    /** A call's log and database signals, as db-capture now has them (specs/010-mcp-log-investigation). */
    void signals(String callId, CallSignals signals);

    /** These calls were deleted (by a limit, a clean-up or a clear): their marks go too. */
    void callsDeleted(java.util.Collection<String> callIds);

    /** Whether the one-time fill of log and database signals (specs/010) still has to run. */
    boolean signalsBackfillNeeded();

    /** Recorded after the signals of every call captured before it have been written. */
    void signalsBackfillDone(int calls);

    /** Whether the one-time fill from calls recorded before this version still has to run. */
    boolean backfillNeeded();

    /** Recorded after every call reported before it has been written. */
    void backfillDone(int calls);
}
