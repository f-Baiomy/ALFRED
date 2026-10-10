package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.Resolution;

/** Closes a card as Fine, Not in this flow (also Out of scope) or Won't fix, with an optional reason (user only). */
public interface CloseCardUseCase {

    CardChange close(Actor actor, String id, Resolution resolution, String reason);
}
