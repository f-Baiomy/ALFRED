package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

/**
 * A cycle's notes and what it caught (specs/033): the user's description, Claude's summary, and the counts the board's
 * Cycles tab shows. The notes change only here - a rename or a status change keeps them.
 */
public interface CycleNotesUseCase {

    int DESCRIPTION_MAX = 20_000;
    int SUMMARY_MAX = 8_000;

    /** null leaves a note as it is, "" clears it; longer than the limits is refused. Empty when the cycle does not exist. */
    Optional<SessionCycle> updateNotes(String cycleId, String description, String summary);

    Optional<CycleSummary> summary(String cycleId);
}
