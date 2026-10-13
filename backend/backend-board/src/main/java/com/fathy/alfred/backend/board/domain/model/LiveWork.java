package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * What Claude is doing on one card right now for /alfred-live (docs/board.md "Live answers"): the heading ("acting on
 * your answer"), each step as it happens, the reply as it is being written, and how it ended. Held in memory only - it
 * describes work in progress, never a record; the reply itself lands on the card as an ordinary comment.
 *
 * @param id       the run's own id (one per change of the user's that Claude answers)
 * @param state    WORKING while it runs; DONE, FAILED or STOPPED once it ended
 * @param stop     the user pressed Stop - the runner ends the run at its next report
 */
public record LiveWork(String id, String project, int cardNumber, String head, List<String> steps, String draft, State state,
                       String outcome, boolean stop, Instant startedAt, Instant updatedAt) {

    public enum State { WORKING, DONE, FAILED, STOPPED }

    public LiveWork {
        steps = steps == null ? List.of() : List.copyOf(steps);
    }

    public boolean ended() {
        return state != State.WORKING;
    }

    public LiveWork stopRequested(Instant at) {
        return new LiveWork(id, project, cardNumber, head, steps, draft, state, outcome, true, startedAt, at);
    }
}
