package com.fathy.alfred.backend.internalcalls.application.service;

import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReceiveCompletedCallUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReceivePreparedCallUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsPage;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Mirrors backend-calls' CallsService, trimmed to this slice's much simpler scope: no legacy
 * single-shot webhook, no settings-based call filtering - just two-phase prepare/complete over a
 * single file-backed adapter, plus (unlike backend-calls) only a completion-time observer fan-out
 * since this slice has no two-phase capture concept at all.
 */
@Service
public class InternalCallsService implements GetCallsUseCase, GetCallDetailUseCase,
        ReceivePreparedCallUseCase, ReceiveCompletedCallUseCase {

    private static final Logger log = LoggerFactory.getLogger(InternalCallsService.class);

    private final CallLogPort callLogPort;
    private final CallNotificationPort notificationPort;
    private final List<NewInternalCallObserverPort> observers;

    /** Upper bound on a single page's size regardless of what the caller asks for, so a request can't force an unbounded read/response. Same property InternalCallsFileLogAdapter uses to ring-buffer its file, so the two stay in sync by construction. */
    @Value("${alfred.internal-calls.max-limit:200}")
    private int maxLimit;

    /** See CallListSupport.apply's paginationEnabled param - disabling reproduces the pre-pagination "everything up to maxLimit in one response" behavior. */
    @Value("${alfred.internal-calls.pagination-enabled:true}")
    private boolean paginationEnabled;

    public InternalCallsService(CallLogPort callLogPort, CallNotificationPort notificationPort, List<NewInternalCallObserverPort> observers) {
        this.callLogPort = callLogPort;
        this.notificationPort = notificationPort;
        this.observers = observers;
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
                query.search(), query.supplier(), query.sort(), clampedOffset, clampedLimit, paginationEnabled,
                query.sessionId(), query.operationId(), query.requestId());
        return new CallsPage(page.items(), page.total());
    }

    /** Delegates to the port - a linear scan over the in-memory cache for the file adapter. */
    @Override
    public Optional<CallDetail> getDetail(String callId) {
        return callLogPort.findById(callId).map(CallDetail::of);
    }

    /**
     * The proxy just intercepted a request, before WildFly has responded.
     *
     * <p>{@code partial.id()} is normally the proxy's own generated id (from X-Request-Id, or a
     * fresh UUID if the client didn't send one) - only generated here as a fallback for a
     * blank/missing id, since every call must have one. {@code sessionId}/{@code operationId} are
     * passed through exactly as received with no fallback - a call the client never tagged with
     * either simply has {@code null} for that field, rather than a value invented server-side
     * (matching the same rule already applied in backend-calls' CallsService.receivePreparedCall).
     */
    @Override
    public Optional<String> receivePreparedCall(CallRecord partial) {
        String id = valueOrGenerated(partial.id());
        CallRecord prepared = new CallRecord(id, partial.originalUrl(), partial.url(), partial.method(),
                partial.request(), partial.timestamp(), null, null, null, CallLifecycleStatus.IN_PROGRESS,
                partial.sessionId(), partial.operationId());
        callLogPort.prepare(prepared);
        notificationPort.notifyCallPrepared(prepared);
        return Optional.of(id);
    }

    /**
     * Fills in a previously-prepared call's outcome, then fans out to observers (a recording
     * session-cycle decides fresh here whether to capture the call - this slice has no two-phase
     * capture concept, unlike backend-calls), and only then notifies, mirroring
     * receivePreparedCall's own "persist, then notify" order so a client reacting to the
     * WebSocket push always finds the row already updated.
     */
    @Override
    public boolean receiveCompletedCall(String id, ResponseData response, String error, Double durationMs) {
        boolean updated = callLogPort.complete(id, response, error, durationMs);
        if (!updated) {
            log.warn("Received a completion for unknown/already-trimmed internal call id {}", id);
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

    private static String valueOrGenerated(String value) {
        return (value != null && !value.isBlank()) ? value : UUID.randomUUID().toString();
    }
}
