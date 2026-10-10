package com.fathy.alfred.backend.board.domain.model;

import java.util.List;

/**
 * One Fixed card checked against a re-test cycle: the cycle's calls to the card's endpoint and what they say -
 * STILL_FAILING (one ended the way the card's call did), LOOKS_FIXED (all ok now) or NOT_EXERCISED (the cycle never
 * called it). A card without a signature (no call mentioned) is NOT_EXERCISED with no calls.
 */
public record FixCheck(int number, String project, String title, String signature, Verdict verdict, List<Seen> calls) {

    public enum Verdict { STILL_FAILING, LOOKS_FIXED, NOT_EXERCISED }

    public FixCheck {
        calls = List.copyOf(calls);
    }

    /** A call of the cycle to the card's endpoint, as a mention ref with its label. */
    public record Seen(String ref, String label, String signal) {
    }
}
