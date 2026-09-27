package com.fathy.alfred.backend.scenarios.application.port.in;

import com.fathy.alfred.backend.scenarios.domain.model.NewScenario;
import com.fathy.alfred.backend.scenarios.domain.model.Scenario;

public interface CreateScenarioUseCase {

    /** @throws IllegalArgumentException if name/definition exceed the documented limits (adapter.in.web maps this to 400). */
    Scenario create(NewScenario newScenario);
}
