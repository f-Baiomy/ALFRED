package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/**
 * A write a reader asked the owner for (D10-D13). The owner keeps it with {@code incoming} true; the reader keeps its
 * own copy so it can show "waiting" and withdraw it. {@code target} is the owner's own id (a card, a call, a board);
 * {@code extra} is the kind's own detail as JSON (a brief passage, the comment kind). {@code resultRef} is what the
 * owner made of it, kept so Undo can take it back. {@code via} names the middle Alfred of a passed-on stream.
 */
public record LinkRequest(String id, String streamId, String linkId, boolean incoming, RequestKind kind, String target,
                          String targetLabel, String text, String extra, String author, RequestState state, String resultRef,
                          String note, Instant createdAt, Instant answeredAt, boolean auto) {

    public LinkRequest answered(RequestState newState, String newResultRef, String newNote, Instant at, boolean byAuto) {
        return new LinkRequest(id, streamId, linkId, incoming, kind, target, targetLabel, text, extra, author, newState,
                newResultRef == null ? resultRef : newResultRef, newNote == null ? note : newNote, createdAt, at, byAuto);
    }
}
