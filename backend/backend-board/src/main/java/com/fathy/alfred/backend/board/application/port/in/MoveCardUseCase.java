package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardStatus;

/** Moves a card between open statuses. Claude may move only to To do, In progress or Fixed. */
public interface MoveCardUseCase {

    CardChange move(Actor actor, String id, CardStatus status);
}
