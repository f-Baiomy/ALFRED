package com.fathy.alfred.backend.internalcalls.application.port.out;

import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;

import java.util.List;
import java.util.Optional;

/** Outbound port: how the application core reads and persists logged internal calls, without knowing they live in a flat file. */
public interface CallLogPort {

    /**
     * First half of two-phase logging: persists {@code call} with {@code state == IN_PROGRESS}
     * (response/error/durationMs all null) the moment the proxy intercepts a request, before
     * WildFly has responded. {@code call.id()} is already assigned by the caller.
     */
    void prepare(CallRecord call);

    /**
     * Second half: fills in the outcome of a previously-{@link #prepare}d call - either
     * {@code response} (a real HTTP reply, any status code) or {@code error} (the proxy never got
     * one).
     *
     * @return true if a call with this id was found and updated, false if not (already trimmed by
     * retention, or never prepared - the caller should treat this as a 404).
     */
    boolean complete(String id, ResponseData response, String error, Double durationMs);

    /**
     * Filtered/searched/sorted/paginated call summaries, plus the total count matching before
     * pagination, plus optional substring filters scoped to a call's own id, session id, or
     * operation id - each combined with the others (and the general search/supplier filters) via
     * AND, narrowing rather than widening the result. A blank filter is not applied at all.
     */
    CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                             String sessionId, String operationId, String requestId);

    /** A single call by id, or empty if no call with that id has ever been logged. */
    Optional<CallRecord> findById(String id);

    /** Bytes currently occupied on disk by this adapter's storage. */
    long storageSizeBytes();

    /** Counts of every logged call grouped into ok (2xx/3xx) / client error (4xx) / server error (5xx or a captured proxy error). */
    CallStatusBreakdown statusBreakdown();

    /** Permanently deletes every logged call. */
    void deleteAll();

    /** All logged calls, in file order (oldest first). */
    List<CallRecord> readAll();
}
