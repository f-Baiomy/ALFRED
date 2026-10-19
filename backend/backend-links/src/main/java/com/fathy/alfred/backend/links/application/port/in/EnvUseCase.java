package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.EnvCycle;
import com.fathy.alfred.backend.links.domain.model.EnvDef;
import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;

import java.time.Instant;
import java.util.List;

/**
 * Environments (D35-D41). The host names a board's environments and gives each to an Alfred (itself or a linked one).
 * An environment's marks, step ticks, test cycles and re-tests live on its own Alfred, which alone writes them (its
 * Claude directly, D37) and streams them back; the host reads every column live and the board's Overall is "every
 * required environment passes" (D39).
 */
public interface EnvUseCase {

    record EnvIn(String name, String linkId, boolean required) {
    }

    /** One environment's column: the host's own (from the board) or an environment Alfred's (read live). */
    record EnvColumn(String name, String linkId, String slug, String alfred, boolean required, boolean here, boolean online, String error,
                     List<EnvMark> marks, List<EnvStep> steps, List<EnvRetest> retests, List<EnvCycle> cycles, String verdict,
                     List<String> missing, Asks asks) {
    }

    /** One acceptance item a board asks every environment for. */
    record AskItem(String fileName, String itemKey, String text) {
    }

    /** What the board asks each environment: its acceptance items, test steps and the cards to re-test (Fixed). */
    record Asks(List<AskItem> items, List<String> steps, List<Integer> fixedCards) {
    }

    /** The whole matrix of a board, with its Overall (PASS, FAIL or WAITING with the environments waited on). */
    record EnvBoard(String boardId, List<EnvColumn> columns, String overall, List<String> waitingOn, List<String> failing, Instant at,
                    Asks asks) {
    }

    /** On an environment Alfred: a board it does an environment of. */
    record Assigned(String hostLinkId, String hostSlug, String hostName, boolean hostOnline, String boardId, String boardName, String project,
                    String env) {
    }

    // ------------------------------------------------------------------------------------------------------- the host

    List<EnvDef> envs(String boardId);

    List<EnvDef> setEnvs(String boardId, String boardName, String project, List<EnvIn> envs);

    EnvBoard board(String boardId);

    /** Tags one of the host's own cycles as a test (or re-test) cycle of one of its environments. */
    EnvCycle tagCycle(String boardId, String cycleRef, String env, List<Integer> retestFor, String name);

    void untagCycle(String boardId, String cycleRef);

    List<EnvCycle> cycles(String boardId);

    // ------------------------------------------------------------------------------------------ an environment Alfred

    List<Assigned> assignments();

    EnvColumn mine(String hostSlug, String boardId);

    EnvMark mark(String hostSlug, String boardId, String fileName, String itemKey, String mark, String evidence, boolean claude);

    void clearMark(String hostSlug, String boardId, String fileName, String itemKey);

    EnvStep step(String hostSlug, String boardId, String stepKey, String state, String note, boolean claude);

    void clearStep(String hostSlug, String boardId, String stepKey);

    /** "● Record for STG": a new cycle here, recording, streamed to the host and put on its board (D38, D41). */
    EnvCycle record(String hostSlug, String boardId, String name, List<Integer> retestFor);

    /** Judges this environment's re-tests for the given Fixed cards (all of them when empty) from one cycle's calls (D40). */
    List<EnvRetest> retest(String hostSlug, String boardId, List<Integer> cardNumbers, String cycleId, boolean claude);
}
