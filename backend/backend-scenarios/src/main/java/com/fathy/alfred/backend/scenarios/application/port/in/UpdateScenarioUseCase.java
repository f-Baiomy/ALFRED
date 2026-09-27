package com.fathy.alfred.backend.scenarios.application.port.in;

import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioUpdate;

import java.util.Optional;

public interface UpdateScenarioUseCase {

    /** @throws IllegalArgumentException if name/definition exceed the documented limits (adapter.in.web maps this to 400). */
    Optional<Scenario> update(String id, ScenarioUpdate update);
}
