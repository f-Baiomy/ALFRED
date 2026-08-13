package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.Optional;

/** Inbound port for the proxy's first webhook call - a request was just intercepted, before the upstream has responded. */
public interface ReceivePreparedCallUseCase {

    /**
     * @param partial The request-side data only - id/response/error/durationMs/state are ignored
     *                even if set, this method assigns them.
     * @return the id assigned to this call, or empty if the host/URL filter rejected it (nothing
     * was logged - the proxy should not call {@code complete} for this call).
     */
    Optional<String> receivePreparedCall(CallRecord partial);
}
