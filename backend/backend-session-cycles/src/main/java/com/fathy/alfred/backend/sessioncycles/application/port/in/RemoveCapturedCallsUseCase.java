package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;

import java.util.List;
import java.util.Optional;

/** Bulk-removes a set of captured calls from a cycle in one pass - the multi-select "Remove selected" bulk action's backing use case, as opposed to RemoveCapturedCallUseCase's single-call removal. */
public interface RemoveCapturedCallsUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404). */
    Optional<RemoveCallsResult> removeCalls(String cycleId, List<String> callIds);
}
