package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.ActivityEntry;

import java.util.List;
import java.util.Optional;

/** A card's history, oldest first, paged. Empty when the card does not exist. */
public interface ListActivityUseCase {

    int MAX_LIMIT = 1000;

    record ActivityPage(List<ActivityEntry> entries, int total) {
    }

    Optional<ActivityPage> activity(String id, int offset, int limit);
}
