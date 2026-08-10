package com.fathy.alfred.backend.calls.application.service;

import com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceiveNewCallUseCase;
import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.function.Function;

@Service
public class CallsService implements GetCallsUseCase, ReceiveNewCallUseCase {

    private final CallLogPort callLogPort;
    private final CallNotificationPort notificationPort;
    private final List<NewCallObserverPort> observers;

    /** Upper bound on a single page's size regardless of what the caller asks for, so a request can't force an unbounded read/response. Same property FileCallLogAdapter uses to ring-buffer RECENT_CALLS.log, so the two stay in sync by construction. */
    @Value("${alfred.calls.max-limit:200}")
    private int maxLimit;

    /** See CallListSupport.apply's paginationEnabled param - disabling reproduces the pre-pagination "everything up to maxLimit in one response" behavior. */
    @Value("${alfred.calls.pagination-enabled:true}")
    private boolean paginationEnabled;

    public CallsService(CallLogPort callLogPort, CallNotificationPort notificationPort, List<NewCallObserverPort> observers) {
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

        CallListSupport.Page<CallRecord> page = CallListSupport.apply(
                callLogPort.readAll(), Function.identity(),
                query.search(), query.supplier(), query.sort(), clampedOffset, clampedLimit, paginationEnabled);
        return new CallsPage(page.items(), page.total());
    }

    /**
     * The proxy only calls the webhook now - it doesn't write any file itself - so this is where
     * a call actually becomes durable. Saved first, then fanned out to any observers (e.g. session
     * cycles capturing it), then broadcast last - a client that reacts to the WebSocket push and
     * immediately re-fetches GET /calls, or a cycle's own calls endpoint, must always find the
     * record already there.
     */
    @Override
    public void receiveNewCall(CallRecord call) {
        callLogPort.save(call);
        List<String> capturedByCycleIds = observers.stream()
                .flatMap(observer -> observer.onNewCall(call).stream())
                .toList();
        notificationPort.notifyNewCall(call, capturedByCycleIds);
    }
}
