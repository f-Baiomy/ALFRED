package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * One comment or one recorded change on a card; history is shown oldest first (id order). {@code replyTo} is the
 * thread a comment belongs to - the first comment of it (one level: a reply to a reply points at the first comment of
 * the thread), or null. {@code answers} is the comment a reply was written to when that is itself a reply (specs/023:
 * the timeline draws replies as a tree); null for a reply to the thread's first comment and for every older reply.
 */
public record ActivityEntry(long id, String cardId, Actor actor, ActivityKind kind, String text, String oldValue,
                            String newValue, Instant at, Long replyTo, Long answers) {

    public ActivityEntry(long id, String cardId, Actor actor, ActivityKind kind, String text, String oldValue, String newValue,
                         Instant at, Long replyTo) {
        this(id, cardId, actor, kind, text, oldValue, newValue, at, replyTo, null);
    }

    public ActivityEntry(long id, String cardId, Actor actor, ActivityKind kind, String text, String oldValue, String newValue,
                         Instant at) {
        this(id, cardId, actor, kind, text, oldValue, newValue, at, null, null);
    }

    /** A question Claude asked (its comment starts with **Question**). */
    public boolean isQuestion() {
        return kind == ActivityKind.COMMENT && actor == Actor.CLAUDE && text != null && text.startsWith("**Question**");
    }
}
