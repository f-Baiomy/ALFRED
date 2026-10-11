package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

import java.util.List;

/**
 * Sets the teams a card is assigned to - the user from the board, Claude from its tools (any card, any time: Claude
 * reassigns as it learns more). Every change is one history entry with the old and new teams and the reason.
 */
public interface AssignTeamsUseCase {

    CardChange assignTeams(Actor actor, String cardId, List<String> teams, String reason);
}
