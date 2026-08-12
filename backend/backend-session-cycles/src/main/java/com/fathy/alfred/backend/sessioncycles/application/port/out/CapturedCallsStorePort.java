package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;

import java.util.List;

/** Outbound port: per-cycle captured-call persistence - one file per cycle today, without the application core knowing that. */
public interface CapturedCallsStorePort {

    List<CapturedCall> findAllByCycle(String cycleId);

    CapturedCall append(String cycleId, CallRecord call);

    /** @return true if a captured call with this id existed in this cycle and was removed. */
    boolean removeById(String cycleId, String callId);

    /** @return how many of the given ids existed in this cycle and were removed - a single read+rewrite of the cycle's file, not one removeById call per id. */
    int removeByIds(String cycleId, List<String> callIds);

    /** Deletes this cycle's entire captured-calls file - called when the cycle itself is deleted. */
    void deleteAllForCycle(String cycleId);
}
