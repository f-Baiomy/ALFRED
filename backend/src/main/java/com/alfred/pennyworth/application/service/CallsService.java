package com.alfred.pennyworth.application.service;

import com.alfred.pennyworth.application.port.in.GetCallsUseCase;
import com.alfred.pennyworth.application.port.out.CallLogPort;
import com.alfred.pennyworth.domain.model.CallRecord;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@Service
public class CallsService implements GetCallsUseCase {

    /** Upper bound on /calls?limit= regardless of what the caller asks for, so a request can't force an unbounded read/response. */
    static final int MAX_LIMIT = 500;

    private final CallLogPort callLogPort;

    public CallsService(CallLogPort callLogPort) {
        this.callLogPort = callLogPort;
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
}
