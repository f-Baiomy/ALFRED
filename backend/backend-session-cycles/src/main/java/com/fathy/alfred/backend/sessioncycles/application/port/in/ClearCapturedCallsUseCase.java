package com.fathy.alfred.backend.sessioncycles.application.port.in;

public interface ClearCapturedCallsUseCase {

    /** Permanently deletes every captured call (external and internal) for this cycle, leaving the cycle itself and its metadata untouched. @return true if the cycle existed. */
    boolean clearCalls(String cycleId);
}
