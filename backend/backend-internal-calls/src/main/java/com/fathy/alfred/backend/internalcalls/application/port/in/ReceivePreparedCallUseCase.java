package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;

import java.util.Optional;

/** Inbound port for the reverse proxy's first webhook call - a request was just intercepted, before WildFly has responded. */
public interface ReceivePreparedCallUseCase {

    /**
     * @param partial The request-side data, plus (normally) the proxy's own generated id -
     *                response/error/durationMs/state are ignored even if set, this method assigns
     *                them. A blank/missing id is filled in server-side as a fallback.
     * @return the id this call was logged under.
     */
    Optional<String> receivePreparedCall(CallRecord partial);
}
