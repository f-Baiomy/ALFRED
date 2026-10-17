package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.Actor;

import java.util.List;

/** Board ↔ cycle and board ↔ board relations (specs/027 FR-003, FR-004). Unrelating never touches the cycle or its calls. */
public interface RelateCycleUseCase {

    Result relateCycle(Actor actor, String boardId, String cycleId);

    Result unrelateCycle(Actor actor, String boardId, String cycleId);

    Result relateBoard(Actor actor, String boardId, String otherId);

    Result unrelateBoard(Actor actor, String boardId, String otherId);

    List<String> cyclesOf(String boardId);

    List<String> boardsOfCycle(String cycleId);

    /**
     * The cycles a task key stands for: a board's related cycles, or the key itself when it names no board (an old
     * caller passing a cycle id).
     */
    List<String> cyclesOfTask(String taskKey);
}
