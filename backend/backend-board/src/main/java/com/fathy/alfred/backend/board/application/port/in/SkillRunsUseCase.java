package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.SkillRun;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Skills run from the board with ▶ (docs/board.md "Run from the board"): queued for the chat that handles the cycle,
 * handed to that chat by its runner (which waits on {@link #onQueued} - no polling), taken and ended by the chat.
 */
public interface SkillRunsUseCase {

    /** The user's ▶. Refused (with why) without a cycle, when no chat handles the cycle, or the same card / command already waits or runs. */
    Outcome request(Request request);

    /** The runs a board shows: every queued or running one, then the latest ended ones; and how long each skill usually takes. */
    Page list(String project, Integer cardNumber, int limit);

    /** The chat's runner takes up to {@code max} queued runs of the cycles its chat handles, to hand them to the chat (SENT). */
    List<SkillRun> claim(String chatId, String host, int max);

    /** The runner's report: the whole current state of one run. Returns the run as held, with stop set when the user pressed Stop. */
    Optional<SkillRun> report(String id, Report report);

    /** Cancel: a run the chat has not taken yet. One the chat runs is the chat's, not interrupted. */
    Optional<SkillRun> stop(String id);

    /** Cancel every run of a project ("" = every project) the chat has not taken yet; returns how many. */
    int stopAll(String project);

    /** Called once, the next time a run is queued (then gone): the runner's long wait. */
    AutoCloseable onQueued(Runnable listener);

    record Request(String project, String cycleId, Integer cardNumber, String command, String prompt, String note, String model, String host,
                   boolean autoRetry) {
    }

    record Report(SkillRun.State state, List<String> steps, String outcome, String failure, Instant retryAt, String result) {
    }

    /** {@code usualMs}: the median duration of the last finished runs of each skill (by its name, e.g. /alfred-fix). */
    record Page(List<SkillRun> runs, Map<String, Long> usualMs) {
    }

    /** The run, or why it was not queued: {@code error} not-found (no runner), conflict (already running) or invalid. */
    record Outcome(SkillRun run, String error, String message) {

        public static Outcome ok(SkillRun run) {
            return new Outcome(run, null, null);
        }

        public static Outcome refused(String error, String message) {
            return new Outcome(null, error, message);
        }
    }
}
