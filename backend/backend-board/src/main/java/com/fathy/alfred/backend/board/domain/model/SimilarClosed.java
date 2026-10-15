package com.fathy.alfred.backend.board.domain.model;

/**
 * A closed card an Inbox card resembles (same signature): shown as a hint so the user can decide in a second. {@code kind}
 * is the closed card's - the hint is shown only for a card that could be the same problem (BoardService).
 */
public record SimilarClosed(int number, String title, Resolution resolution, String reason, CardKind kind) {

    public SimilarClosed(int number, String title, Resolution resolution, String reason) {
        this(number, title, resolution, reason, null);
    }
}
