package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/**
 * A card's short name (specs/021): the few words every mention of it reads - "All Agencies untested (#47)". The user
 * sets or clears it from the drawer; Claude may give one only to a card that has none.
 */
public interface ShortNameUseCase {

    int MAX_SHORT_NAME = 60;

    CardChange setShortName(Actor actor, String cardId, String shortName);
}
