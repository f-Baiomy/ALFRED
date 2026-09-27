package com.fathy.alfred.backend.scenarios.application.port.in;

import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;

import java.util.List;
import java.util.Optional;

public interface ListRunsUseCase {

    /** Newest first, without {@code results}. Empty Optional means no scenario with this id exists (404). */
    Optional<List<RunListItem>> listRuns(String scenarioId);
}
