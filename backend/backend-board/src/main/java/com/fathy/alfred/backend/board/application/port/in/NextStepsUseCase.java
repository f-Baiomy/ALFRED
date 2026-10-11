package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.NextSteps;

/** What one board waits on - the next-step bar and Claude's /alfred-status. */
public interface NextStepsUseCase {

    NextSteps nextSteps(String project, String cycleId);
}
