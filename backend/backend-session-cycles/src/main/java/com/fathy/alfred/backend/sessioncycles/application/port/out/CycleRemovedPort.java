package com.fathy.alfred.backend.sessioncycles.application.port.out;

/**
 * Told after a session cycle is deleted, so what other features keep about it can go too - the task board's brief and
 * spec files (specs/014-task-board research R4). This slice knows nothing of who listens.
 */
public interface CycleRemovedPort {

    void cycleRemoved(String cycleId);
}
