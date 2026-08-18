package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;

import java.util.List;
import java.util.Optional;

/** Bulk-removes a set of captured internal calls from a cycle in one pass - mirrors RemoveCapturedCallsUseCase for the internal-calls path. */
public interface RemoveCapturedInternalCallsUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404). */
    Optional<RemoveCallsResult> removeCalls(String cycleId, List<String> callIds);
}
