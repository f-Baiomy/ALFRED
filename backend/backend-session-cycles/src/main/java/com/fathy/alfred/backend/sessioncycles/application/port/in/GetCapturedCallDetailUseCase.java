package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallDetail;

import java.util.Optional;

/**
 * Inbound port: the full request/response (headers+bodies) for one captured call, fetched only
 * once it's actually expanded - see CapturedCallSummary for why the list view omits this.
 * Deliberately separate from calls' GetCallDetailUseCase even though the shape is identical -
 * a captured call's body can outlive its presence in RECENT_CALLS.log (a capped ring buffer),
 * since the cycle's own captured-calls file has no such cap, so it needs its own lookup scoped to
 * that cycle's file rather than falling back to the main log.
 */
public interface GetCapturedCallDetailUseCase {

    /** Empty Optional means either the cycle or the captured call itself doesn't exist. */
    Optional<CallDetail> getDetail(String cycleId, String callId);
}
