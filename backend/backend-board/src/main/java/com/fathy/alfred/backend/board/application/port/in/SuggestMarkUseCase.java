package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Mark;

/** Claude suggests a checklist mark with evidence; only the user turns it into a mark (accept) or drops it (dismiss). */
public interface SuggestMarkUseCase {

    MarkChecklistUseCase.MarkOutcome suggest(Actor actor, String cycleId, String fileName, String itemKey, Mark mark, String evidence);

    MarkChecklistUseCase.MarkOutcome acceptSuggestion(Actor actor, String cycleId, String fileName, String itemKey);

    MarkChecklistUseCase.MarkOutcome dismissSuggestion(Actor actor, String cycleId, String fileName, String itemKey);
}
