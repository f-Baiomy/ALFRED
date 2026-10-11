package com.fathy.alfred.backend.board.domain.model;

import java.util.List;

/** A Done / Verified card whose endpoint failed again in recent live calls the way it did before (specs/015 FR-17). */
public record Regression(String project, int number, String title, CardStatus status, String signature, List<FixCheck.Seen> calls) {

    public Regression {
        calls = List.copyOf(calls);
    }
}
