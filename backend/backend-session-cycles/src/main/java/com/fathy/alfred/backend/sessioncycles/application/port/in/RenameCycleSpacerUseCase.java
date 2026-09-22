package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;

import java.util.Optional;

public interface RenameCycleSpacerUseCase {

    /** @return empty if the cycle or the spacer doesn't exist. */
    Optional<CycleSpacer> renameSpacer(String cycleId, String spacerId, String label);
}
