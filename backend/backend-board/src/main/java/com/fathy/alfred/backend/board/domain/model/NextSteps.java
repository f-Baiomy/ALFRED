package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * What the board waits on, for the next-step bar: the cards waiting on the user (oldest first, with why) and how many
 * cards wait on Claude, on a re-test, or in the Inbox to be sorted.
 */
public record NextSteps(List<Item> waitingOnUser, int waitingOnClaude, int toDo, int inProgress, int fixed, int inbox) {

    public NextSteps {
        waitingOnUser = List.copyOf(waitingOnUser);
    }

    /** {@code why}: question, proposal, inbox or other. */
    public record Item(String project, int number, String title, CardStatus status, String why, Instant since) {
    }
}
