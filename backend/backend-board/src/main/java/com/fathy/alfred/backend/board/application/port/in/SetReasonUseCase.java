package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Sets the reason of a closed card - "Add reason" after a close (user only). */
public interface SetReasonUseCase {

    CardChange setReason(Actor actor, String id, String reason);
}
