package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;

import java.util.Optional;

/** Inbound port: the full request/response (headers+bodies) for one call, fetched only once it's actually expanded - see CallSummary for why the list view omits this. */
public interface GetCallDetailUseCase {

    Optional<CallDetail> getDetail(String callId);

    /** The list-row shape (method/url/status/timestamp/...) for one call known only by id - a
     *  caller that never saw this call in a list (Relive's Live calls log, T074: it only stores
     *  {@code loggedCallId}) has no other way to get a resend- or export-ready CallRecord. */
    Optional<CallSummary> getSummary(String callId);

    /** The stored interception, bodies included. The list summary omits them. Empty when this call has none. */
    Optional<CallInterception> getInterception(String callId);
}
