package com.alfred.pennyworth.calls.application.service;

import com.alfred.pennyworth.calls.application.port.in.GetCallsUseCase;
import com.alfred.pennyworth.calls.application.port.in.ReceiveNewCallUseCase;
import com.alfred.pennyworth.calls.application.port.out.CallLogPort;
import com.alfred.pennyworth.calls.application.port.out.CallNotificationPort;
import com.alfred.pennyworth.calls.domain.model.CallRecord;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@Service
public class CallsService implements GetCallsUseCase, ReceiveNewCallUseCase {

    /** Upper bound on /calls?limit= regardless of what the caller asks for, so a request can't force an unbounded read/response. */
    static final int MAX_LIMIT = 500;

    private final CallLogPort callLogPort;
    private final CallNotificationPort notificationPort;

    public CallsService(CallLogPort callLogPort, CallNotificationPort notificationPort) {
        this.callLogPort = callLogPort;
        this.notificationPort = notificationPort;
    }

    @Override
    public List<CallRecord> getCalls(int limit) {
        int clampedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));

        List<CallRecord> all = callLogPort.readAll();
        int fromIndex = Math.max(0, all.size() - clampedLimit);
        List<CallRecord> recent = all.subList(fromIndex, all.size());

        List<CallRecord> newestFirst = new ArrayList<>(recent);
        Collections.reverse(newestFirst);
        return newestFirst;
    }

    /**
     * calls.log (via CallLogPort) is still the source of truth for GET /calls - this exists
     * purely to fan the event out live over WebSocket, since the proxy already has it in hand
     * and pushing it beats waiting for the next poll to pick it up from the file.
     */
    @Override
    public void receiveNewCall(CallRecord call) {
        notificationPort.notifyNewCall(call);
    }
}
