package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;

import java.util.List;
import java.util.Optional;

/**
 * Outbound port: per-cycle captured-internal-call persistence, without the application core
 * knowing whether it's a file-per-cycle or something else. Mirrors CapturedCallsStorePort, but
 * simpler - backend-internal-calls has no two-phase capture concept at all (no SQLite adapter to
 * need it), so there is deliberately no {@code supportsTwoPhaseCapture()}/{@code completeCapturedCall}
 * here.
 */
public interface CapturedInternalCallsStorePort {

    List<CapturedInternalCall> findAllByCycle(String cycleId);

    CapturedInternalCall append(String cycleId, CallRecord call);

    /** @return true if a captured call with this id existed in this cycle and was removed. */
    boolean removeById(String cycleId, String callId);

    /** @return how many of the given ids existed in this cycle and were removed - a single read+rewrite of the cycle's file, not one removeById call per id. */
    int removeByIds(String cycleId, List<String> callIds);

    /** Deletes this cycle's entire captured-internal-calls file - called when the cycle itself is deleted. */
    void deleteAllForCycle(String cycleId);

    /**
     * Filtered/searched/sorted/paginated captured call summaries for one cycle - returns
     * {@link CapturedInternalCallSummary} (not the full {@link CapturedInternalCall}) for the same
     * reason CallLogPort.query returns CallSummary: list views never need request/response bodies.
     */
    CallListSupport.Page<CapturedInternalCallSummary> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled);

    /**
     * As {@link #query}, plus three optional substring filters scoped to one column each - see
     * {@link com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort}'s identical
     * overload. Defaults to ignoring them (falls back to {@link #query}) so an adapter without
     * dedicated support for these still satisfies this interface without change.
     */
    default CallListSupport.Page<CapturedInternalCallSummary> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                                                      String sessionId, String operationId, String requestId) {
        return query(cycleId, search, supplier, sort, offset, limit, paginationEnabled);
    }

    /** Looks up a captured call by the underlying CallRecord's id (not the CapturedInternalCall wrapper's own id) - what GET /session-cycles/{id}/internal-calls/{callId}/detail keys on. */
    Optional<CapturedInternalCall> findByCallId(String cycleId, String callId);

    /** Bytes currently occupied on disk by this adapter's storage - drives the Database settings tab's file-size table. */
    long storageSizeBytes();

    /** Total captured internal calls across every cycle - drives the Database settings tab's row-count column. */
    long countAll();

    /** Permanently deletes every captured internal call across every cycle - the Database settings tab's "Clear cycles" action. */
    void deleteAll();
}
