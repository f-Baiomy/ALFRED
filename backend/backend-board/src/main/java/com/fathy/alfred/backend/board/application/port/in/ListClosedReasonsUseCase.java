package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.ClosedReason;

import java.util.List;

/** The closed cards of a project with their reasons - what Claude reads before reporting (FR-043). */
public interface ListClosedReasonsUseCase {

    int MAX_LIMIT = 500;

    List<ClosedReason> closedReasons(String project, int limit);
}
