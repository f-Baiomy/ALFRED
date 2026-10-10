package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Deletes a card with its history and mentions (user only). */
public interface DeleteCardUseCase {

    CardChange delete(Actor actor, String id);
}
