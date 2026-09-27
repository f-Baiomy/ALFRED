package com.fathy.alfred.backend.scenarios.application.port.in;

import com.fathy.alfred.backend.scenarios.domain.model.ScenarioSummary;

import java.util.List;

public interface ListScenariosUseCase {

    /** Newest first, without {@code definition}. */
    List<ScenarioSummary> listAll();
}
