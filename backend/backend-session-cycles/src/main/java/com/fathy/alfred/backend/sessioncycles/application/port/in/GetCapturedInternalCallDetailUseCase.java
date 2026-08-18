package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;

import java.util.Optional;

/**
 * Inbound port: the full request/response (headers+bodies) for one captured internal call,
 * fetched only once it's actually expanded - mirrors GetCapturedCallDetailUseCase for the
 * internal-calls path.
 */
public interface GetCapturedInternalCallDetailUseCase {

    /** Empty Optional means either the cycle or the captured call itself doesn't exist. */
    Optional<CallDetail> getDetail(String cycleId, String callId);
}
