package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;

/** A work item type and its states, each with the provider's category (Proposed, InProgress, Resolved, Completed, Removed). */
public record TypeStates(String project, String type, List<State> states) {

    public record State(String name, String category) {
    }

    public TypeStates {
        states = states == null ? List.of() : List.copyOf(states);
    }

    /** The categories an "open" item is not in. */
    public static boolean closed(String category) {
        return "Completed".equalsIgnoreCase(category) || "Removed".equalsIgnoreCase(category);
    }
}
