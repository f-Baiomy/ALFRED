package com.fathy.alfred.backend.relive.application.port.in;

/** Inbound port: wiping run history from the database. Targets still RUNNING are stopped first
 *  (the same drain-safe path as a manual stop), never deleted mid-flight. */
public interface DeleteRunHistoryUseCase {

    /** Deletes the selected runs (or the whole history, for an empty {@code runIds}) and every
     *  step result, permanently. With {@code deleteCalls}, the logged calls those runs produced
     *  are deleted too, along with their Live-calls log rows; otherwise every logged call and
     *  every Live-calls row is kept. The logged-call cleanup runs in the background - it can
     *  involve scanning a large call log - and each call store signals the dashboard the moment
     *  its own rows are gone. */
    DeletedRunHistory delete(String cycleId, DeleteRunHistoryCommand command);

    /** {@code runs} = history rows removed; {@code callsCleanupStarted} = whether the background
     *  cleanup of the logged calls was started (always false when the calls were kept). */
    record DeletedRunHistory(int runs, boolean callsCleanupStarted) {
    }
}
