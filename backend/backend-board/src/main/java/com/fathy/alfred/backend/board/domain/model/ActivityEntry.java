package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** One comment or one recorded change on a card; history is shown oldest first (id order). */
public record ActivityEntry(long id, String cardId, Actor actor, ActivityKind kind, String text, String oldValue,
                            String newValue, Instant at) {
}
