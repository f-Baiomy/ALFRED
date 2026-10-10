package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Sends a closed card back to the Inbox (user only). */
public interface ReopenCardUseCase {

    CardChange reopen(Actor actor, String id);
}
