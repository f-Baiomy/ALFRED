package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.Optional;

/** Inbound port for the proxy's first webhook call - a request was just intercepted, before the upstream has responded. */
public interface ReceivePreparedCallUseCase {

    /**
     * @param partial The request-side data, plus (normally) the proxy's own generated id -
     *                response/error/durationMs/state are ignored even if set, this method assigns
     *                them. A blank/missing id is filled in server-side as a fallback.
     * @return the id this call was logged under, or empty if the host/URL filter rejected it
     * (nothing was logged - a later {@code complete} call for this id will just 404).
     */
    Optional<String> receivePreparedCall(CallRecord partial);
}
