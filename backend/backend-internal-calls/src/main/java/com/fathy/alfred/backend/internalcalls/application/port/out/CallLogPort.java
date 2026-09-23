package com.fathy.alfred.backend.internalcalls.application.port.out;

import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallBaseline;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.RecentRequestHeaders;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;

import java.net.URI;
import java.time.Instant;
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
     * The same, carrying what an interception rule did to the call. A default that drops the
     * record, so a store that predates it (and every test fake) keeps working; the file adapter,
     * this slice's only real store, overrides it.
     */
    default boolean complete(String id, ResponseData response, String error, Double durationMs,
                             CallInterception interception) {
        return complete(id, response, error, durationMs);
    }

    /**
     * Filtered/searched/sorted/paginated call summaries, plus the total count matching before
     * pagination, plus optional substring filters scoped to a call's own id, session id, or
     * operation id, plus an optional comma-separated project-name filter (see
     * CallsQuery.serviceNames) - each combined with the others (and the general search/supplier
     * filters) via AND, narrowing rather than widening the result. A blank filter is not applied
     * at all.
     */
    CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                             String sessionId, String operationId, String requestId, String serviceNames);

    /**
     * Resolved (never IN_PROGRESS) internal calls whose timestamp falls within {@code [from, to]}
     * (inclusive both ends), optionally narrowed by search/serviceNames/sessionId/operationId/
     * requestId - built for backend-call-overlap's global "what happened in this window" query,
     * unbounded by whatever page is currently loaded in the browser (unlike {@link #query}, which
     * paginates). Defaults to filtering the full in-memory {@link #readAll()} - dead simple by
     * design, since every caller only ever passes a narrow time window (see
     * {@link CallListSupport#resolvedInRange} for the actual filter logic).
     */
    default List<CallRecord> findResolvedInRange(Instant from, Instant to, String search,
                                                  String sessionId, String operationId, String requestId, String serviceNames) {
        return CallListSupport.resolvedInRange(readAll(), from, to, search, sessionId, operationId, requestId, serviceNames);
    }

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

    /** Completed calls to this exact url only - see CallBaseline. */
    CallBaseline baselineFor(String url);

    /**
     * Request headers of the newest calls to {@code authority}, newest first, at most
     * {@code limit} rows - backs "resend with current session". Matches on the authority of
     * either the upstream {@code url} or the client-facing {@code originalUrl} (whichever
     * parses and matches), since either could plausibly be what a caller means by "this host"
     * for an inbound call.
     */
    default List<RecentRequestHeaders> recentRequestHeaders(String authority, int limit) {
        List<RecentRequestHeaders> result = new java.util.ArrayList<>();
        List<CallRecord> all = readAll();
        for (int i = all.size() - 1; i >= 0 && result.size() < limit; i--) {
            CallRecord call = all.get(i);
            if (call.request() == null) {
                continue;
            }
            if (matchesAuthority(call.url(), authority) || matchesAuthority(call.originalUrl(), authority)) {
                result.add(new RecentRequestHeaders(call.id(), call.timestamp(), call.request().headers()));
            }
        }
        return result;
    }

    private static boolean matchesAuthority(String url, String authority) {
        if (url == null) {
            return false;
        }
        try {
            String callAuthority = URI.create(url).getRawAuthority();
            return callAuthority != null && callAuthority.equalsIgnoreCase(authority);
        } catch (Exception e) {
            return false;
        }
    }
}
