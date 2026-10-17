package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardStatus;

/**
 * A card's status changed (specs/028 FR-070, FR-075): the Team slice prepares "Tell Azure" and cleanup bundles for the
 * items the card links. Wired by backend-app/teamboardsbridge; absent, nothing happens. It never changes the move.
 */
public interface CardStatusChangedPort {

    void statusChanged(Card card, CardStatus from, Actor actor);
}
