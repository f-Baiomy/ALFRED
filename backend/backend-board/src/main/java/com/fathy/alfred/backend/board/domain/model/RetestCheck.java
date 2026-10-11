package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * One card re-tested (specs/016): the calls to its endpoint since it was fixed (or in a re-test cycle), each checked
 * against the card's expectations, with the before value from the card's original call.
 * <ul>
 *   <li>PASSES - every call passes every expectation (enough calls for each);</li>
 *   <li>PARTIAL - the calls so far pass, but a step was not done yet or a duration needs more calls;</li>
 *   <li>FLAKY - some calls pass and some fail;</li>
 *   <li>FAILS - every call fails an expectation;</li>
 *   <li>NO_CALLS - nothing called the endpoint since the fix;</li>
 *   <li>NOT_CHECKABLE - the card names no call, so Alfred cannot tell which endpoint to watch.</li>
 * </ul>
 * {@code statusOnly} is true when the card has no expectations and only the status was compared. {@code since} is when
 * the watch starts: the fix (Fixed) or the Verified / Done move (a guard). {@code newBuild} is true when the app
 * restarted after the fix and nothing was re-tested since.
 */
public record RetestCheck(int number, String project, String title, CardStatus status, Instant since, Verdict verdict,
                          boolean statusOnly, String summary, List<Result> results, List<CallResult> calls, List<StepResult> steps,
                          boolean newBuild) {

    public enum Verdict { PASSES, PARTIAL, FLAKY, FAILS, NO_CALLS, NOT_CHECKABLE }

    public enum Outcome { PASS, FAIL, UNKNOWN, WAITING }

    public RetestCheck {
        results = List.copyOf(results);
        calls = List.copyOf(calls);
        steps = List.copyOf(steps);
    }

    /** One expectation over the calls: its outcome, the original value, and each call's value (newest first). */
    public record Result(String text, Expectation expectation, Outcome outcome, String before, List<String> after, String note) {

        public Result {
            after = List.copyOf(after);
        }
    }

    /** One call checked: as a mention ref with its label, whether it passed, and the first expectation it failed. */
    public record CallResult(String ref, String label, Instant at, boolean passed, String failed) {
    }

    /** One re-test step: done when a call to its endpoint was seen. */
    public record StepResult(String text, String endpoint, boolean seen, int calls) {
    }
}
