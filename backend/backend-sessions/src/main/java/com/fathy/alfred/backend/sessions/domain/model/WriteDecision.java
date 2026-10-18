package com.fathy.alfred.backend.sessions.domain.model;

/**
 * May this caller write on this board (specs/031)? A board nobody holds is open as before; a held board takes writes only
 * from its holder - any of the holder's keys, on any of their PCs - and card comments from the commenters the
 * holder named (their chat messages go through the holder's OK instead). {@code holder} is set when refused, so the page
 * can say who holds it.
 */
public record WriteDecision(boolean allowed, String reason, Holder holder) {

    public static final String FREE = "FREE";
    public static final String HOLDER = "HOLDER";
    public static final String COMMENTER = "COMMENTER";
    public static final String HELD = "HELD";

    public static WriteDecision allow(String reason) {
        return new WriteDecision(true, reason, null);
    }

    public static WriteDecision held(Holder h) {
        return new WriteDecision(false, HELD, h);
    }

    /**
     * What kind of write: a card comment or reaction (commenters may), a chat message (a commenter's waits for the holder's
     * OK in its own queue, so it is refused here), or anything else (only the holder).
     */
    public enum Kind { COMMENT, MESSAGE, EDIT }
}
