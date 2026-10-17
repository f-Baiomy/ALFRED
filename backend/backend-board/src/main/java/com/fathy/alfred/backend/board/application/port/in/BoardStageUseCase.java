package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.BoardStage;

import java.util.Optional;

/** Where a board (a task) stands in the workflow, and its one next step (specs/030 FR-013). */
public interface BoardStageUseCase {

    /** Empty when there is no such board. */
    Optional<BoardStage> stage(String boardId);
}
