package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A card's owner (specs/028 FR-089): a tracker person, {@code <conn>/<personId>|Name}, shown as a pill. The user sets it
 * on any card; Claude only on its own Inbox cards. Mentions of people (@[person:<conn>/<id>|Name]) are indexed like
 * every mention, so "cards mentioning me" is a lookup.
 */
public interface CardOwnerUseCase {

    int MAX_OWNER = 300;

    Optional<String> owner(String cardId);

    Map<String, String> owners(List<String> cardIds);

    CardChange setOwner(Actor actor, String cardId, String owner);

    /** Cards owned by and cards mentioning {@code <conn>/<personId>}, newest first, at most {@code limit} each. */
    record PersonCards(List<Card> owned, List<Card> mentioning) {
    }

    PersonCards cardsOf(String personRef, int limit);
}
