package com.fathy.alfred.backend.scenarios.application.port.in;

import com.fathy.alfred.backend.scenarios.domain.model.NewRun;
import com.fathy.alfred.backend.scenarios.domain.model.Run;

import java.util.Optional;

public interface CreateRunUseCase {

    /**
     * Empty when no scenario with this id exists (404).
     * @throws IllegalArgumentException if {@code results} exceeds the documented limit (adapter.in.web maps this to 400).
     */
    Optional<Run> createRun(String scenarioId, NewRun newRun);
}
