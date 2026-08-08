package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.alfred.pennyworth.sessioncycles.domain.model.CopyCallsResult;

import java.util.List;
import java.util.Optional;

/** Manually duplicates a bulk selection of calls into a cycle - unlike live capture, this works regardless of the cycle's RECORDING/PAUSED status, since it's a deliberate one-off action, not the recording fan-out. */
public interface CopyCallsToCycleUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404). */
    Optional<CopyCallsResult> copyInto(String cycleId, List<CallRecord> calls);
}
