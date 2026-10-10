package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/** The mark on one acceptance item, by item key (SHA-256 of its normalized text, so it survives an unchanged replace).
 *  {@code actor} is always USER in specs/014; the later spec-verification feature adds Claude marks without migration. */
public record ChecklistMark(String cycleId, String fileName, String itemKey, Mark mark, Actor actor, String evidence,
                            List<Change> history, Instant updatedAt) {

    public ChecklistMark {
        evidence = evidence == null ? "" : evidence;
        history = history == null ? List.of() : List.copyOf(history);
    }

    public record Change(Mark mark, Actor actor, Instant at) {
    }
}
