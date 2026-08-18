package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;

import java.util.List;
import java.util.Optional;

/** Internal-calls mirror of CopyCallsToCycleUseCase - manually duplicates a bulk selection of frontend->WildFly calls into a cycle, regardless of RECORDING/PAUSED status. */
public interface CopyInternalCallsToCycleUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404). */
    Optional<CopyCallsResult> copyInto(String cycleId, List<CallRecord> calls);
}
