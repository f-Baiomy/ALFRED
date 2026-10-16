package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A comment on a session cycle's brief (specs/024): about a passage of it ({@code quote}, as it read when the comment
 * was made) or about the whole brief (no quote). A reply points at the comment that starts its thread ({@code replyTo});
 * only a thread's first comment carries the quote and is resolved. Claude may ask ({@code asks}) and may suggest a
 * rewording ({@code suggestFrom} -> {@code suggestTo}) that changes the brief only when the user applies it.
 */
public record BriefComment(long id, String cycleId, String quote, Actor actor, String text, Long replyTo, boolean asks,
                           String suggestFrom, String suggestTo, Instant createdAt, Instant resolvedAt, Actor resolvedBy) {

    public boolean hasSuggestion() {
        return suggestFrom != null && suggestTo != null;
    }
}
