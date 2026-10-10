package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Undoes a close: restores what the close recorded, only shortly after it and only if nothing else changed since. */
public interface UndoCloseUseCase {

    CardChange undoClose(Actor actor, String id);
}
