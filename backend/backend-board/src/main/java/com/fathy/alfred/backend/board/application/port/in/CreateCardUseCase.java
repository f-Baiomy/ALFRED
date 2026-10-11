package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.MentionRef;

import java.util.List;
import java.util.Set;

/** Adds a card. Claude's cards always land in the Inbox, and one that repeats a card the user closed as Fine or Not in
 *  this flow (same signature) is refused. */
public interface CreateCardUseCase {

    /** {@code teams}: the team ids to assign; null or empty lets the teams' hints pick them from the card's own words. */
    record NewCard(String project, CardKind kind, String title, String description, Set<Flag> flags, String cycleId,
                   CardStatus status, List<MentionRef> links, List<String> teams) {
        public NewCard(String project, CardKind kind, String title, String description, Set<Flag> flags, String cycleId,
                       CardStatus status, List<MentionRef> links) {
            this(project, kind, title, description, flags, cycleId, status, links, null);
        }
    }

    CardChange create(Actor actor, NewCard card);
}
