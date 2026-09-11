package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;

import java.time.Instant;
import java.util.List;

/**
 * Inbound port: resolved internal calls (never IN_PROGRESS - an in-progress call has no fixed end
 * time, so it can't be "contained" in anything and is simply omitted) whose timestamp falls within
 * {@code [from, to]}, optionally narrowed by search/serviceNames/sessionId/operationId/requestId.
 * Built for backend-call-overlap's global "what calls happened in this time window" query - unlike
 * {@link GetCallsUseCase}, this returns the full unpaginated match set, since callers only ever
 * pass a narrow time window.
 */
public interface GetCallsInRangeUseCase {

    List<CallRecord> getCallsInRange(Instant from, Instant to, String search, String sessionId,
                                      String operationId, String requestId, String serviceNames);
}
