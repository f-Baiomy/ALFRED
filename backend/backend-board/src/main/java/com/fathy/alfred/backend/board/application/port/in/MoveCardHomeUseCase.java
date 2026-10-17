package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

import java.util.List;

/** A card's home board and related cycles (specs/027 US2): the number and history never change with them. */
public interface MoveCardHomeUseCase {

    CardChange moveHome(Actor actor, String cardId, String boardId);

    CardChange relateCardCycle(Actor actor, String cardId, String cycleId);

    CardChange unrelateCardCycle(Actor actor, String cardId, String cycleId);

    List<String> relatedCycles(String cardId);
}
