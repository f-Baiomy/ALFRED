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
import java.util.ArrayList;
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
     * Appends one WebSocket connection's newly-batched messages to {@code callId}'s own list -
     * capped per call at {@code alfred.internal-calls.ws-max-messages}. See backend-calls'
     * CallLogPort.appendWsMessages for the full doc - this mirrors it.
     */
    void appendWsMessages(String callId, List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> messages,
                          boolean closed, Integer closeCode);

    /** One call's WebSocket messages, oldest first, paginated. */
    com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage wsMessages(String callId, int offset, int limit);

    /** The largest page {@link #recentRequestHeaders} will ever return. */
    int MAX_RECENT_REQUEST_HEADERS = 200;

    /**
     * The newest calls to {@code host}, request headers only, newest first, capped at
     * {@link #MAX_RECENT_REQUEST_HEADERS} - a scan of {@link #readAll()}, i.e. of whatever the
     * inbound ring currently retains (see docs/architecture.md on why this slice has no SQLite
     * adapter to push the query down into).
     */
    default List<RecentRequestHeaders> recentRequestHeaders(String host, int limit) {
        int cap = Math.min(limit, MAX_RECENT_REQUEST_HEADERS);
        List<RecentRequestHeaders> out = new ArrayList<>();
        List<CallRecord> all = readAll();
        for (int i = all.size() - 1; i >= 0 && out.size() < cap; i--) {
            CallRecord call = all.get(i);
            if (call.request() == null || !hostMatches(call.url(), host)) {
                continue;
            }
            out.add(new RecentRequestHeaders(call.id(), call.request().headers()));
        }
        return out;
    }

    private static boolean hostMatches(String url, String host) {
        if (url == null || host == null) {
            return false;
        }
        try {
            return host.equalsIgnoreCase(URI.create(url).getHost());
        } catch (RuntimeException e) {
            return false;
        }
    }
}
