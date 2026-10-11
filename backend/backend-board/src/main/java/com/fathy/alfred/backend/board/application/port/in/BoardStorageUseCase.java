package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardStorage;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Settings -> Storage -> Board: board.db's size and free space, and Compact (user only). */
public interface BoardStorageUseCase {

    BoardStorage storage();

    /** Compacts board.db; the storage before and after. */
    Compacted compact(Actor actor);

    record Compacted(CardChange.Outcome outcome, BoardStorage before, BoardStorage after, String message) {
    }
}
