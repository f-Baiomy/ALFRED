package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;

import java.util.List;
import java.util.Optional;

/** Outbound port: per-cycle captured-call persistence, without the application core knowing whether it's a file-per-cycle or a database row. */
public interface CapturedCallsStorePort {

    List<CapturedCall> findAllByCycle(String cycleId);

    CapturedCall append(String cycleId, CallRecord call);

    /** @return true if a captured call with this id existed in this cycle and was removed. */
    boolean removeById(String cycleId, String callId);

    /** @return how many of the given ids existed in this cycle and were removed - a single read+rewrite of the cycle's file, not one removeById call per id. */
    int removeByIds(String cycleId, List<String> callIds);

    /** Deletes this cycle's entire captured-calls file - called when the cycle itself is deleted. */
    void deleteAllForCycle(String cycleId);

    /** Filtered/searched/sorted/paginated captured calls for one cycle - same contract as CallLogPort.query, so every adapter behaves identically from SessionCyclesService's point of view. */
    CallListSupport.Page<CapturedCall> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled);

    /** Looks up a captured call by the underlying CallRecord's id (not the CapturedCall wrapper's own id) - what GET /session-cycles/{id}/calls/{callId}/detail keys on. */
    Optional<CapturedCall> findByCallId(String cycleId, String callId);
}
