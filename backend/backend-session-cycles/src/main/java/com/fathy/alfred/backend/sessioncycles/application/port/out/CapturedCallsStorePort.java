package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary;

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

    /**
     * Filtered/searched/sorted/paginated captured call summaries for one cycle - returns
     * {@link CapturedCallSummary} (not the full {@link CapturedCall}) for the same reason
     * CallLogPort.query returns CallSummary: list views never need request/response bodies, so a
     * SQL-backed adapter can skip fetching those large columns entirely.
     */
    CallListSupport.Page<CapturedCallSummary> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled);

    /** Looks up a captured call by the underlying CallRecord's id (not the CapturedCall wrapper's own id) - what GET /session-cycles/{id}/calls/{callId}/detail keys on. */
    Optional<CapturedCall> findByCallId(String cycleId, String callId);

    /** Bytes currently occupied on disk by this adapter's storage - drives the Database settings tab's file-size table. */
    long storageSizeBytes();

    /** Total captured calls across every cycle - drives the Database settings tab's row-count column. */
    long countAll();

    /** Permanently deletes every captured call across every cycle - the Database settings tab's "Clear cycles" action (paired with SessionCycleMetadataStorePort.deleteAll()). */
    void deleteAll();

    /**
     * Whether this adapter can persist an in-progress captured call at {@link #append} time and
     * later fill in its outcome via {@link #completeCapturedCall} - true for the SQLite adapter,
     * false for the JSON file adapter (which deliberately keeps its pre-existing single-shot
     * behavior - see the two-phase logging plan). {@link com.fathy.alfred.backend.sessioncycles.adapter.out.capture.SessionCycleCaptureAdapter}
     * uses this to decide whether to capture a call at prepare time at all, or wait and decide
     * fresh once it completes (today's behavior).
     */
    boolean supportsTwoPhaseCapture();

    /**
     * Two-phase logging, second half - fills in the outcome of a captured call previously
     * {@link #append}ed in state IN_PROGRESS, identified by the underlying CallRecord's id (not
     * the CapturedCall wrapper's own id) within one specific cycle. Only ever called when
     * {@link #supportsTwoPhaseCapture()} is true.
     * @return true if a captured call with this call id existed in this cycle and was updated.
     */
    boolean completeCapturedCall(String cycleId, String callId, ResponseData response, String error, Double durationMs);
}
