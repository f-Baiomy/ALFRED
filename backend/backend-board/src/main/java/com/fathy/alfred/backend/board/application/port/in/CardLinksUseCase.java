package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** A card blocked by another card of its project, and the Acceptance items a card is about (specs/015 FR-13, FR-16). */
public interface CardLinksUseCase {

    CardChange block(Actor actor, String id, int blockedByNumber);

    CardChange unblock(Actor actor, String id, int blockedByNumber);

    CardChange linkSpecItem(Actor actor, String id, String cycleId, String fileName, String itemKey);

    CardChange unlinkSpecItem(Actor actor, String id, String cycleId, String fileName, String itemKey);
}
