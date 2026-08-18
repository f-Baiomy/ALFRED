package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;

import java.util.Optional;

/** Mirrors ListCapturedCallsUseCase for the internal-calls path (frontend->WildFly traffic). */
public interface ListCapturedInternalCallsUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404) - distinct from a cycle that exists but has captured nothing matching {@code query} yet (200, empty page). Filters, sorts, and paginates server-side, same as GET /internal-calls. */
    Optional<CapturedInternalCallsPage> listCalls(String cycleId, CallsQuery query);
}
