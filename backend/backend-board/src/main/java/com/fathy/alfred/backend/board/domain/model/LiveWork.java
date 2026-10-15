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
 * @param chatMessageId the chat message this run answers (specs/022), null for a card's run; {@code cardNumber} is 0 then
 * @param usage    the tokens the run used, as the runner read them from its result (input, output, cacheRead, cacheWrite,
 *                 costUsd) - the chat's token meter (FR-056); null until it ended
 */
public record LiveWork(String id, String project, int cardNumber, String head, List<String> steps, String draft, State state,
                       String outcome, boolean stop, Instant startedAt, Instant updatedAt, Long chatMessageId, java.util.Map<String, Double> usage) {

    public enum State { WORKING, DONE, FAILED, STOPPED }

    public LiveWork {
        steps = steps == null ? List.of() : List.copyOf(steps);
    }

    public LiveWork(String id, String project, int cardNumber, String head, List<String> steps, String draft, State state, String outcome,
                    boolean stop, Instant startedAt, Instant updatedAt) {
        this(id, project, cardNumber, head, steps, draft, state, outcome, stop, startedAt, updatedAt, null, null);
    }

    public LiveWork(String id, String project, int cardNumber, String head, List<String> steps, String draft, State state, String outcome,
                    boolean stop, Instant startedAt, Instant updatedAt, Long chatMessageId) {
        this(id, project, cardNumber, head, steps, draft, state, outcome, stop, startedAt, updatedAt, chatMessageId, null);
    }

    public boolean ended() {
        return state != State.WORKING;
    }

    public LiveWork stopRequested(Instant at) {
        return new LiveWork(id, project, cardNumber, head, steps, draft, state, outcome, true, startedAt, at, chatMessageId, usage);
    }
}
