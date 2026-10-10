package com.fathy.alfred.backend.board.domain.model;

/** The outcome of a write: the card after it, or why it was not made. */
public record CardChange(Outcome outcome, CardDetail card, String message) {

    public enum Outcome { OK, NOT_FOUND, INVALID, REFUSED_FOR_CLAUDE, ILLEGAL_TRANSITION, DUPLICATE_OF_CLOSED, PAUSED, CONFLICT }

    public static CardChange ok(CardDetail card) {
        return new CardChange(Outcome.OK, card, null);
    }

    public static CardChange refused(Outcome outcome, String message) {
        return new CardChange(outcome, null, message);
    }

    public static CardChange notFound() {
        return new CardChange(Outcome.NOT_FOUND, null, "No such card");
    }
}
