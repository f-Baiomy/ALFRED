package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

import java.util.List;

/** One action on several selected cards (user only). */
public interface BulkCardsUseCase {

    int MAX_CARDS = 200;

    enum Action { FINE, NOT_IN_FLOW, TO_DO, MARK_URGENT }

    record BulkOutcome(CardChange.Outcome outcome, int updated, String message) {
    }

    BulkOutcome bulk(Actor actor, List<String> ids, Action action, String reason);
}
