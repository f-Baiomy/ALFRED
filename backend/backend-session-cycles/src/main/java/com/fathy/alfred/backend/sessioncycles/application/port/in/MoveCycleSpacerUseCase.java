package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;

import java.util.Optional;

public interface MoveCycleSpacerUseCase {

    /** @return empty if the cycle or the spacer doesn't exist. beforeCallId null means "after every call". */
    Optional<CycleSpacer> moveSpacer(String cycleId, String spacerId, String beforeCallId);
}
