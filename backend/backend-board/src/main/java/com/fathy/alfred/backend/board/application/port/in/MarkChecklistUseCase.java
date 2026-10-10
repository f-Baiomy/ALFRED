package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChecklistFile;
import com.fathy.alfred.backend.board.domain.model.ChecklistItem;
import com.fathy.alfred.backend.board.domain.model.Mark;

import java.util.List;

/** Acceptance items of a cycle's spec files and the user's marks on them. */
public interface MarkChecklistUseCase {

    int MAX_EVIDENCE = 8 * 1024;

    List<ChecklistFile> checklist(String cycleId);

    record MarkOutcome(CardChange.Outcome outcome, ChecklistItem item, String message) {
    }

    MarkOutcome mark(Actor actor, String cycleId, String fileName, String itemKey, Mark mark, String evidence);
}
