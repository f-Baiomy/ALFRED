package com.fathy.alfred.backend.relive.application.port.out;

import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.StepState;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** Outbound port: run persistence for a cycle's execution history. */
public interface ReliveRunStorePort {

    Run create(Run run);

    /** With {@code definition}, {@code log}, everything. */
    Optional<Run> findById(String runId);

    /** Like {@link #findById} but without the definition (null) - for changes that only touch the
     *  run's state, its log, or need its cycle id. */
    default Optional<Run> findStateById(String runId) {
        return findById(runId);
    }

    /** Newest first, without {@code definition}/{@code log} (constitution II - list is headers only). */
    List<Run> listByCycleId(String cycleId, int limit);

    /** All RUNNING runs, for RunLeaseRegistry's startup sweep (T047). */
    List<Run> findAllRunning();

    Run update(Run run);

    /**
     * Writes everything about the run except its definition, which does not change while it runs
     * (only updateDefinition and resume touch it, through {@link #update}). The definition holds
     * every recorded body of the cycle, so rewriting it for each step result, variable or log line
     * cost megabytes per write (review P1).
     */
    default void updateState(Run run) {
        update(run);
    }

    void putStepResult(StepResult result);

    /** Every attempt of every step of this run, ordered by step then attempt. */
    List<StepResult> listStepResults(String runId);

    /** Step, attempt, state and attribution of every attempt - no bodies (review P2: the summary is
     *  recomputed on each step result and used to parse every stored response to do it). */
    default List<StepOutcome> listStepOutcomes(String runId) {
        return listStepResults(runId).stream()
                .map(r -> new StepOutcome(r.stepKey(), r.attempt(), r.state(), r.attribution()))
                .toList();
    }

    record StepOutcome(String stepKey, int attempt, StepState state, String attribution) {
    }

    /** Trims a cycle's run history to the newest {@code keep} rows and {@code maxBytes} total,
     *  oldest first, never touching {@code relive_live_calls}. */
    void pruneRuns(String cycleId, int keep, long maxBytes);

    void deleteByCycleId(String cycleId);

    /** Deletes exactly these runs and their step results - the explicit history-delete path
     *  ({@code DeleteRunHistoryUseCase}), not retention. Rows already gone are ignored. */
    void deleteByIds(Collection<String> runIds);
}
