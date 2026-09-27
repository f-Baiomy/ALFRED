package com.fathy.alfred.backend.scenarios.application.port.in;

import com.fathy.alfred.backend.scenarios.domain.model.Run;

import java.util.Optional;

public interface GetRunUseCase {

    /** Empty when either the scenario or the run doesn't exist. */
    Optional<Run> getRun(String scenarioId, String runId);
}
