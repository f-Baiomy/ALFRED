package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A numbered step under the brief's "Test steps" heading (specs/015 FR-14) and what the cycle showed for it: its calls,
 * and the card it failed into. Keyed like an acceptance item (the hash of its text).
 */
public record TestStep(String key, String text, StepState state, int calls, Integer cardNumber, String note, Instant at) {
}
