package com.fathy.alfred.backend.scenarios.application.port.in;

import com.fathy.alfred.backend.scenarios.domain.model.Scenario;

import java.util.Optional;

public interface GetScenarioUseCase {

    Optional<Scenario> getById(String id);
}
