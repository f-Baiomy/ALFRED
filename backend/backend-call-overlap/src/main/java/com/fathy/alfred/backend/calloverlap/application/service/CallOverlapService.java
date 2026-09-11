package com.fathy.alfred.backend.calloverlap.application.service;

import com.fathy.alfred.backend.calloverlap.application.port.in.GetCallOverlapsUseCase;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapQuery;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * Merges backend-calls' and backend-internal-calls' own windowed/filtered query use cases into one
 * flat list of {@link CallOverlapEntry} - no sorting, no containment/nesting logic (entirely a
 * frontend concern, see the class using this data client-side). Depends directly on each slice's
 * own inbound port (GetCallsInRangeUseCase, once in backend-calls and once in
 * backend-internal-calls - same simple name, distinguished by package) exactly the way
 * SessionCyclesService depends on both slices' domain types.
 */
@Service
public class CallOverlapService implements GetCallOverlapsUseCase {

    private final com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase externalCallsInRange;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase internalCallsInRange;

    public CallOverlapService(
            com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase externalCallsInRange,
            com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase internalCallsInRange) {
        this.externalCallsInRange = externalCallsInRange;
        this.internalCallsInRange = internalCallsInRange;
    }

    @Override
    public List<CallOverlapEntry> getOverlaps(CallOverlapQuery query) {
        List<com.fathy.alfred.backend.calls.domain.model.CallRecord> external =
                externalCallsInRange.getCallsInRange(query.from(), query.to(), query.search(), query.supplier());
        List<com.fathy.alfred.backend.internalcalls.domain.model.CallRecord> internal =
                internalCallsInRange.getCallsInRange(query.from(), query.to(), query.search(),
                        query.sessionId(), query.operationId(), query.requestId(), query.serviceNames());

        List<CallOverlapEntry> merged = new ArrayList<>(external.size() + internal.size());
        for (com.fathy.alfred.backend.calls.domain.model.CallRecord call : external) {
            merged.add(fromExternal(call));
        }
        for (com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call : internal) {
            merged.add(fromInternal(call));
        }
        return merged;
    }

    private static CallOverlapEntry fromExternal(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        Integer status = call.response() != null ? call.response().status() : null;
        return new CallOverlapEntry(call.id(), CallOverlapEntry.SOURCE_EXTERNAL, call.serviceName(),
                call.timestamp(), call.durationMs(), status, call.error());
    }

    private static CallOverlapEntry fromInternal(com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call) {
        Integer status = call.response() != null ? call.response().status() : null;
        return new CallOverlapEntry(call.id(), CallOverlapEntry.SOURCE_INTERNAL, call.serviceName(),
                call.timestamp(), call.durationMs(), status, call.error());
    }
}
