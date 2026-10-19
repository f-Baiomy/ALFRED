package com.fathy.alfred.backend.links.domain.model;

/** The writes a reader may ask the owner for (D10). Everything else is never sent through a stream (D9). */
public enum RequestKind {
    /** A comment on one of the board's cards. */
    CARD_COMMENT,
    /** A question on a card - a comment the owner sees as a question. */
    CARD_QUESTION,
    /** A comment on a passage of the board's brief. */
    BRIEF_COMMENT,
    /** A note on a call of a streamed cycle (the owner's call comments). */
    CALL_NOTE
}
