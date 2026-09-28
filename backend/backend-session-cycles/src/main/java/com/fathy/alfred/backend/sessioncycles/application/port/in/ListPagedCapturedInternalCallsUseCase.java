package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;

import java.util.Optional;

/** Opt-in paging for callers that must traverse all captured inbound calls. */
public interface ListPagedCapturedInternalCallsUseCase extends ListCapturedInternalCallsUseCase {
    Optional<CapturedInternalCallsPage> listCalls(String cycleId, CallsQuery query, boolean paged);
}
