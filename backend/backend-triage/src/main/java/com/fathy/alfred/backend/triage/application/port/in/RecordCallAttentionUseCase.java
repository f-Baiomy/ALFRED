package com.fathy.alfred.backend.triage.application.port.in;

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

    /** Whether the one-time fill from calls recorded before this version still has to run. */
    boolean backfillNeeded();

    /** Recorded after every call reported before it has been written. */
    void backfillDone(int calls);
}
