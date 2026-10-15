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
     * One thing to do in the app: its text, the endpoint ({@code METHOD /pattern}, as a card's signature names it) whose
     * call shows it was done - blank for the card's own endpoint - and what that call's request must carry (specs/020):
     * a call to the endpoint that sent something else does not do the step.
     */
    public record Step(String text, String endpoint, List<When> request) {

        public static final int MAX_CONDITIONS = 4;

        public Step {
            text = text == null ? "" : text.trim();
            endpoint = endpoint == null || endpoint.isBlank() ? null : endpoint.trim();
            request = request == null ? List.of() : List.copyOf(request);
        }

        public Step(String text, String endpoint) {
            this(text, endpoint, List.of());
        }
    }

    /**
     * What a step's call must send (specs/020): the value at {@code path} ({@code $.branchIds}, {@code $.branch*}) is
     * {@code none}, {@code one}, {@code list}, {@code list>=2} or {@code present} - as an Acceptance item's REQUEST_WHEN -
     * or {@code has:<value>}: it is that value, or a list holding it ({@code has:-11}).
     */
    public record When(String path, String shape) {

        public When {
            path = path == null ? null : path.trim();
            shape = shape == null ? null : shape.trim().replace(" ", "");
        }

        public String problem() {
            if (!EvidenceCheck.validPath(path)) {
                return "A step's request needs a path such as $.branchIds or $.branch*";
            }
            if (shape == null || !(EvidenceCheck.WHEN_SHAPES.contains(shape.toLowerCase(java.util.Locale.ROOT))
                    || (shape.startsWith("has:") && shape.length() > 4 && shape.length() <= 104))) {
                return "A step's request shape is none, one, list, list>=2, present or has:<value>";
            }
            return null;
        }

        /** "branchIds has -11" - for people. */
        public String text() {
            String key = path.substring(path.lastIndexOf('.') + 1);
            return shape.startsWith("has:") ? key + " has " + shape.substring(4) : key + " is " + shape;
        }
    }
}
