package com.fathy.alfred.backend.board.application.port.in;

import java.util.List;
import java.util.Set;

/**
 * What deleting a session cycle would keep (specs/027 FR-017, US6): the calls board texts mention, per board. The same
 * plan answers the delete dialog (a dry run) and the delete itself.
 */
public interface CycleDeletePlanUseCase {

    record BoardKeep(String boardId, String name, List<String> callIds, List<Integer> cards) {
    }

    /** {@code keep}: per board; {@code callIds}: every mentioned call (the cycle keeps these and drops the rest). */
    record Plan(String cycleId, List<BoardKeep> keep, Set<String> callIds) {
    }

    Plan plan(String cycleId);

    /** The cycle now holds only the mentioned calls: boards that mention none of them let it go. */
    void kept(String cycleId);
}
