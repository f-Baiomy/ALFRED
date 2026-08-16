package com.fathy.alfred.backend.calls.application.service;

import com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceiveCompletedCallUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceiveNewCallUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceivePreparedCallUseCase;
import com.fathy.alfred.backend.calls.application.port.out.CallFilterPort;
import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.calls.domain.model.CallDetail;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class CallsService implements GetCallsUseCase, GetCallDetailUseCase, ReceiveNewCallUseCase,
        ReceivePreparedCallUseCase, ReceiveCompletedCallUseCase {

    private static final Logger log = LoggerFactory.getLogger(CallsService.class);

    private final CallLogPort callLogPort;
    private final CallNotificationPort notificationPort;
    private final List<NewCallObserverPort> observers;
    private final Optional<CallFilterPort> callFilterPort;

    /** Upper bound on a single page's size regardless of what the caller asks for, so a request can't force an unbounded read/response. Same property FileCallLogAdapter uses to ring-buffer RECENT_CALLS.log, so the two stay in sync by construction. */
    @Value("${alfred.calls.max-limit:200}")
    private int maxLimit;

    /** See CallListSupport.apply's paginationEnabled param - disabling reproduces the pre-pagination "everything up to maxLimit in one response" behavior. */
    @Value("${alfred.calls.pagination-enabled:true}")
    private boolean paginationEnabled;

    public CallsService(CallLogPort callLogPort, CallNotificationPort notificationPort, List<NewCallObserverPort> observers,
                         Optional<CallFilterPort> callFilterPort) {
        this.callLogPort = callLogPort;
        this.notificationPort = notificationPort;
        this.observers = observers;
        this.callFilterPort = callFilterPort;
    }

    @Override
    public CallsPage getCalls(CallsQuery query) {
        int clampedOffset = Math.max(0, query.offset());
        // Disabled pagination means "everything up to maxLimit in one response", not "whatever
        // small page size the frontend's Load-more happens to be requesting right now" - using
        // query.limit() here would make every Load-more click re-fetch and re-append the exact
        // same first N items forever, since offset is also ignored below.
        int clampedLimit = paginationEnabled ? Math.max(1, Math.min(query.limit(), maxLimit)) : maxLimit;

        CallListSupport.Page<CallSummary> page = callLogPort.query(
                query.search(), query.supplier(), query.sort(), clampedOffset, clampedLimit, paginationEnabled);
        return new CallsPage(page.items(), page.total());
    }

    /** Delegates to the port - an indexed lookup for the SQLite adapter, a linear scan over the in-memory cache for the file adapter. */
    @Override
    public Optional<CallDetail> getDetail(String callId) {
        return callLogPort.findById(callId).map(CallDetail::of);
    }

    /**
     * The legacy single-shot webhook path (POST /calls/webhook) - a call arrives already fully
     * resolved. Kept working unchanged alongside the new two-phase endpoints so an
     * already-running proxy container isn't broken by a backend-only redeploy; the proxy itself
     * moves to {@link #receivePreparedCall}/{@link #receiveCompletedCall} in a later phase.
     */
    @Override
    public void receiveNewCall(CallRecord call) {
        // The proxy's webhook payload has no "id" property, so Jackson deserializes call.id() as
        // null - assigned here, once, at the point the call becomes durable, rather than asking
        // every caller of receiveNewCall to know to do this.
        CallRecord withId = call.id() != null ? call : withGeneratedId(call);
        if (callFilterPort.isPresent() && !callFilterPort.get().isAllowed(withId)) {
            return;
        }
        callLogPort.save(withId);
        List<String> capturedByCycleIds = observers.stream()
                .flatMap(observer -> observer.onNewCall(withId).stream())
                .toList();
        notificationPort.notifyNewCall(withId, capturedByCycleIds);
    }

    /**
     * Two-phase logging, first half - the proxy just intercepted a request, before the upstream
     * has responded. The host/URL filter (request-side only, never response-based) runs here, so
     * a filtered-out call is never logged at all, not even as an in-progress placeholder that
     * would then have no matching {@code complete} call coming. Observers (session-cycle capture)
     * aren't fanned out to here - a recording cycle only sees a call once it completes, exactly as
     * before this feature (see NewCallObserverPort's own phase for when that changes).
     *
     * <p>{@code partial.id()}/{@code sessionId()}/{@code operationId()} are normally the proxy's
     * own values (generated there from X-Request-Id/X-Session-ID/X-Operation-Id, or a fresh UUID
     * per header if the client didn't send one - it no longer waits for this method to hand any of
     * them back) - only generated here as a fallback for whichever come back blank/missing, e.g.
     * an older proxy build still running mid-rollout.
     */
    @Override
    public Optional<String> receivePreparedCall(CallRecord partial) {
        String id = valueOrGenerated(partial.id());
        String sessionId = valueOrGenerated(partial.sessionId());
        String operationId = valueOrGenerated(partial.operationId());
        CallRecord prepared = new CallRecord(id, partial.originalUrl(), partial.url(), partial.method(),
                partial.request(), partial.timestamp(), null, null, null, CallLifecycleStatus.IN_PROGRESS, sessionId, operationId);
        if (callFilterPort.isPresent() && !callFilterPort.get().isAllowed(prepared)) {
            return Optional.empty();
        }
        callLogPort.prepare(prepared);
        List<String> capturedByCycleIds = observers.stream()
                .flatMap(observer -> observer.onCallPrepared(prepared).stream())
                .toList();
        notificationPort.notifyCallPrepared(prepared, capturedByCycleIds);
        return Optional.of(id);
    }

    /**
     * Two-phase logging, second half - fills in a previously-prepared call's outcome and only
     * then fans out to observers/notifies, mirroring receiveNewCall's own "persist, then fan out,
     * then notify" order so a client reacting to the WebSocket push always finds the row already
     * updated.
     */
    @Override
    public boolean receiveCompletedCall(String id, ResponseData response, String error, Double durationMs) {
        boolean updated = callLogPort.complete(id, response, error, durationMs);
        if (!updated) {
            log.warn("Received a completion for unknown/already-trimmed call id {}", id);
            return false;
        }
        Optional<CallRecord> completed = callLogPort.findById(id);
        if (completed.isEmpty()) {
            // Vanishingly unlikely (e.g. retention trimmed the row in the instant between the
            // update above and this read) - the update itself already succeeded, so still report
            // success to the caller; there's just nothing left to fan out/notify about.
            return true;
        }
        CallRecord call = completed.get();
        List<String> capturedByCycleIds = observers.stream()
                .flatMap(observer -> observer.onCallCompleted(call).stream())
                .toList();
        notificationPort.notifyCallCompleted(call, capturedByCycleIds);
        return true;
    }

    private static CallRecord withGeneratedId(CallRecord call) {
        return new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(), call.method(),
                call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }

    private static String valueOrGenerated(String value) {
        return (value != null && !value.isBlank()) ? value : UUID.randomUUID().toString();
    }
}
