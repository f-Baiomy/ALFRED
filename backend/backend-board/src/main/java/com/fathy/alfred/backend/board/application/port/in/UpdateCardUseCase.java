package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.Scope;

import java.util.Set;

/** Changes a card's fields. A null field is left as it is (per-field last write wins); {@code cycleId} "" removes it
 *  from its cycle. Claude may not change scope. */
public interface UpdateCardUseCase {

    record CardEdit(String title, String description, CardKind kind, Set<Flag> flags, Scope scope, String cycleId, String project) {
    }

    CardChange update(Actor actor, String id, CardEdit edit);
}
