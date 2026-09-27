package com.fathy.alfred.backend.scenarios.application.port.out;

import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioSummary;

import java.util.List;
import java.util.Optional;

/** Outbound port: scenario persistence, without the application core knowing it's SQLite today. */
public interface ScenarioStorePort {

    /** Newest first, without {@code definition}; {@code lastRun} still populated. */
    List<ScenarioSummary> findAllSummaries();

    /** With {@code definition} and a freshly computed {@code lastRun}. */
    Optional<Scenario> findById(String id);

    boolean existsById(String id);

    /**
     * Upsert - saves a new scenario or overwrites an existing one with the same id. Returns the
     * saved row re-read with its current {@code lastRun} (a join over the runs table, not a
     * column on this row), so callers never need a separate read-after-write.
     */
    Scenario save(Scenario scenario);

    /** @return true if a scenario with this id existed and was deleted. Does NOT cascade - callers delete its runs first via ScenarioRunStorePort. */
    boolean deleteById(String id);

    /** Bytes currently occupied on disk by this adapter's storage (scenarios.db) - drives the Database settings tab's file-size table. */
    long storageSizeBytes();
}
