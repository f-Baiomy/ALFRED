package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Deletes a card with its history and mentions (user only). */
public interface DeleteCardUseCase {

    CardChange delete(Actor actor, String id);

    /** Deletes every card of a cycle (the user deleting the cycle with its cards); how many went. User only. */
    CycleCardsDeleted deleteCycleCards(Actor actor, String cycleId);

    record CycleCardsDeleted(CardChange.Outcome outcome, int deleted, String message) {
    }
}
