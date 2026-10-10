package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Adds a card from one quick-add line ({@code bug! discount not saved #urgent}). */
public interface QuickAddCardUseCase {

    CardChange quickAdd(Actor actor, String project, String cycleId, String line);
}
