package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * One comment or one recorded change on a card; history is shown oldest first (id order). {@code replyTo} is the
 * comment a comment answers (one level: a reply to a reply points at the first comment of the thread), or null.
 */
public record ActivityEntry(long id, String cardId, Actor actor, ActivityKind kind, String text, String oldValue,
                            String newValue, Instant at, Long replyTo) {

    public ActivityEntry(long id, String cardId, Actor actor, ActivityKind kind, String text, String oldValue, String newValue,
                         Instant at) {
        this(id, cardId, actor, kind, text, oldValue, newValue, at, null);
    }

    /** A question Claude asked (its comment starts with **Question**). */
    public boolean isQuestion() {
        return kind == ActivityKind.COMMENT && actor == Actor.CLAUDE && text != null && text.startsWith("**Question**");
    }
}
