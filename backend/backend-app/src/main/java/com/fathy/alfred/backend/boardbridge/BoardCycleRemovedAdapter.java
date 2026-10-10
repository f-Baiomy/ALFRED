package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.CycleRemovedUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleRemovedPort;
import org.springframework.stereotype.Component;

/** A deleted session cycle takes its board brief, spec files and checklist marks with it; its cards stay (FR-034). */
@Component
public class BoardCycleRemovedAdapter implements CycleRemovedPort {

    private final CycleRemovedUseCase board;

    public BoardCycleRemovedAdapter(CycleRemovedUseCase board) {
        this.board = board;
    }

    @Override
    public void cycleRemoved(String cycleId) {
        board.cycleRemoved(cycleId);
    }
}
