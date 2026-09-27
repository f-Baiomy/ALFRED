package com.fathy.alfred.backend.scenarios.application.port.out;

import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;

import java.util.List;
import java.util.Optional;

/** Outbound port: run persistence for a scenario's execution history. */
public interface ScenarioRunStorePort {

    /** Newest first, without {@code results}. */
    List<RunListItem> findByScenarioId(String scenarioId);

    /** With {@code results}. Empty when no run with this id exists for this scenario. */
    Optional<Run> findById(String scenarioId, String runId);

    /** Inserts a new run, then trims that scenario's history down to the newest {@code retentionLimit} rows. */
    Run save(Run run, int retentionLimit);

    /** Deletes every run of this scenario - the cascade half of DeleteScenarioUseCase. */
    void deleteByScenarioId(String scenarioId);
}
