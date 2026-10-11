package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * How a card's fix is re-tested (specs/016): the expectations every call to its endpoint is checked against, and the
 * steps a person follows to make those calls. Written by Claude with the fix ({@code board_fix}) or by the user in the
 * drawer; {@code updatedBy} says who.
 */
public record RetestPlan(String cardId, List<Expectation> expectations, List<Step> steps, Actor updatedBy, Instant updatedAt) {

    public static final int MAX_STEPS = 20;
    public static final int MAX_STEP_TEXT = 500;

    public RetestPlan {
        expectations = expectations == null ? List.of() : List.copyOf(expectations);
        steps = steps == null ? List.of() : List.copyOf(steps);
    }

    public static RetestPlan empty(String cardId) {
        return new RetestPlan(cardId, List.of(), List.of(), null, null);
    }

    public boolean isEmpty() {
        return expectations.isEmpty() && steps.isEmpty();
    }

    /**
     * One thing to do in the app: its text and the endpoint ({@code METHOD /pattern}, as a card's signature names it) whose
     * call shows it was done - blank for the card's own endpoint.
     */
    public record Step(String text, String endpoint) {

        public Step {
            text = text == null ? "" : text.trim();
            endpoint = endpoint == null || endpoint.isBlank() ? null : endpoint.trim();
        }
    }
}
