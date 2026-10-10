package com.fathy.alfred.backend.board.application.port.in;

/** A session cycle was deleted: its brief, spec files and marks go; its cards stay, marked "cycle deleted". */
public interface CycleRemovedUseCase {

    void cycleRemoved(String cycleId);
}
