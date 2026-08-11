package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallDetail;

import java.util.Optional;

/** Inbound port: the full request/response (headers+bodies) for one call, fetched only once it's actually expanded - see CallSummary for why the list view omits this. */
public interface GetCallDetailUseCase {

    Optional<CallDetail> getDetail(String callId);
}
