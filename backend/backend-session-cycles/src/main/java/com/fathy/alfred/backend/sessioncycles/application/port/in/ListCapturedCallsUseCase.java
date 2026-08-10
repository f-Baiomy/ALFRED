package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;

import java.util.List;
import java.util.Optional;

public interface ListCapturedCallsUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404) - distinct from a cycle that exists but has captured nothing yet (200, empty list). */
    Optional<List<CapturedCall>> listCalls(String cycleId);
}
