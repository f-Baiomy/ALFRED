package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** A mark Claude suggests on an acceptance item, with its evidence. Grey until the user accepts it - marks stay the user's. */
public record ChecklistSuggestion(String cycleId, String fileName, String itemKey, Mark mark, String evidence, Instant at) {

    public ChecklistSuggestion {
        evidence = evidence == null ? "" : evidence;
    }
}
