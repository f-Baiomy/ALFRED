package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;

/** A session cycle's brief. */
public interface ManageBriefUseCase {

    int MAX_TEXT = 256 * 1024;

    CycleBrief brief(String cycleId);

    record BriefOutcome(CardChange.Outcome outcome, CycleBrief brief, String message) {
    }

    BriefOutcome putBrief(Actor actor, String cycleId, String text);
}
