package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * A /alfred-* skill run from the board with ▶ (docs/board.md "Run from the board"): queued for the chat that handles
 * the cycle, handed to that chat by its runner (SENT), taken and run by the chat itself (RUNNING) and ended by it. Kept
 * as the card's (or cycle's) run history.
 *
 * @param cardNumber the card it was run for; null for a cycle- or board-wide command (/alfred-verify &lt;cycle&gt;)
 * @param command    what the button shows, e.g. {@code /alfred-fix 35}
 * @param prompt     the full text sent (the command with its Alfred, project, cycle and card)
 * @param note       the user's note for Claude, sent with the prompt
 * @param host       the runner's machine it must run on; null = whichever runner answers the board
 * @param failure    why it failed: limit, auth, timeout, lost, error (null otherwise)
 * @param retryAt    a run that hit a usage limit and retries by itself: queued again, taken from this moment on
 * @param result     what it wrote, as "#N" (a card) or "#N [i]" (a comment on it), for the "open it" link
 * @param stop       the user pressed Stop on a running run - the runner ends it at its next report
 * @param takenBy    the host of the chat that took it
 * @param chatId     the chat it was queued for (the cycle's chat when it was asked for)
 */
public record SkillRun(String id, String project, String cycleId, Integer cardNumber, String command, String prompt, String note,
                       String model, String host, State state, String outcome, String failure, Instant retryAt, boolean autoRetry,
                       String result, List<String> steps, boolean stop, String takenBy, Instant createdAt, Instant takenAt,
                       Instant endedAt, Instant updatedAt, String chatId) {

    /** QUEUED for the chat · SENT to it (in its watch, waiting for its turn) · RUNNING in it · ended. */
    public enum State { QUEUED, SENT, RUNNING, DONE, FAILED, STOPPED, CANCELLED }

    public SkillRun {
        steps = steps == null ? List.of() : List.copyOf(steps);
    }

    public boolean active() {
        return state == State.QUEUED || state == State.SENT || state == State.RUNNING;
    }

    /** The skill's name, e.g. {@code /alfred-fix} - what "usually takes" is measured by. */
    public String skill() {
        String c = command == null ? "" : command.strip();
        int space = c.indexOf(' ');
        return space < 0 ? c : c.substring(0, space);
    }

    public SkillRun with(State nextState, String nextOutcome, String nextFailure, Instant nextRetryAt, String nextResult, List<String> nextSteps,
                         boolean nextStop, String nextTakenBy, Instant nextTakenAt, Instant nextEndedAt, Instant at) {
        return new SkillRun(id, project, cycleId, cardNumber, command, prompt, note, model, host, nextState, nextOutcome, nextFailure, nextRetryAt,
                autoRetry, nextResult, nextSteps, nextStop, nextTakenBy, createdAt, nextTakenAt, nextEndedAt, at, chatId);
    }
}
