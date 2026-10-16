package com.fathy.alfred.backend.board.domain.model;

import java.util.List;

/**
 * What Claude advises in a card's first open question that recommends an option (specs/020, triage): the option, how
 * sure Claude is ({@code HIGH}, {@code MEDIUM}, {@code LOW} - plain text, read leniently, never an enum: an older Alfred
 * importing it must not throw), what it checked, where the card ranks in the Inbox (worst first, {@code rank} of
 * {@code of}, with the reason) and the cards of the same root cause it proposes merging into this one.
 */
public record Advice(String option, String confidence, String checked, Integer rank, Integer of, String note, List<Integer> group) {

    public Advice {
        group = group == null ? List.of() : List.copyOf(group);
    }

    public static Advice of(String option) {
        return new Advice(option, null, null, null, null, null, List.of());
    }
}
