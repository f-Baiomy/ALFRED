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

    /** The related cycles of many cards at once (the board export, specs/027 T081); cards with none are left out. */
    default java.util.Map<String, List<String>> relatedCycles(java.util.Collection<String> cardIds) {
        java.util.Map<String, List<String>> out = new java.util.LinkedHashMap<>();
        for (String id : cardIds) {
            List<String> c = relatedCycles(id);
            if (!c.isEmpty()) {
                out.put(id, c);
            }
        }
        return out;
    }
}
