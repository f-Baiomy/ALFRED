package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;

import java.util.Optional;

public interface CreateCycleSpacerUseCase {

    /** @return empty if the cycle itself doesn't exist. beforeCallId null means "after every call". */
    Optional<CycleSpacer> createSpacer(String cycleId, String label, String beforeCallId);
}
