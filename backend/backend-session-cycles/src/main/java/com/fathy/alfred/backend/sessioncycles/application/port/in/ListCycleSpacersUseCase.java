package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;

import java.util.List;
import java.util.Optional;

public interface ListCycleSpacersUseCase {

    /** @return empty if the cycle itself doesn't exist. */
    Optional<List<CycleSpacer>> listSpacers(String cycleId);
}
