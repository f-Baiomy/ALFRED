package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage;

import java.util.Optional;

public interface ListCapturedCallsUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404) - distinct from a cycle that exists but has captured nothing matching {@code query} yet (200, empty page). Filters, sorts, and paginates server-side, same as GET /calls. */
    Optional<CapturedCallsPage> listCalls(String cycleId, CallsQuery query);
}
