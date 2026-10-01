package com.fathy.alfred.backend.relive.application.port.out;

import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.StepResult;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** Outbound port: run persistence for a cycle's execution history. */
public interface ReliveRunStorePort {

    Run create(Run run);

    /** With {@code definition}, {@code log}, everything. */
    Optional<Run> findById(String runId);

    /** Newest first, without {@code definition}/{@code log} (constitution II - list is headers only). */
    List<Run> listByCycleId(String cycleId, int limit);

    /** All RUNNING runs, for RunLeaseRegistry's startup sweep (T047). */
    List<Run> findAllRunning();

    Run update(Run run);

    void putStepResult(StepResult result);

    /** Every attempt of every step of this run, ordered by step then attempt. */
    List<StepResult> listStepResults(String runId);

    /** Trims a cycle's run history to the newest {@code keep} rows and {@code maxBytes} total,
     *  oldest first, never touching {@code relive_live_calls}. */
    void pruneRuns(String cycleId, int keep, long maxBytes);

    void deleteByCycleId(String cycleId);

    /** Deletes exactly these runs and their step results - the explicit history-delete path
     *  ({@code DeleteRunHistoryUseCase}), not retention. Rows already gone are ignored. */
    void deleteByIds(Collection<String> runIds);
}
