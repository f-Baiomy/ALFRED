package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;

import java.util.List;

/**
 * The board side of environments (backend-app/linksbridge): what a board asks for (its requirement items, test steps and
 * Fixed cards), the host's own column read from the board itself, starting a test cycle, and judging a re-test from one
 * cycle's calls against cards' re-test plans - on the host with its own board, on an environment Alfred with the host's
 * board read through the stream.
 */
public interface EnvBoardPort {

    /** What a board asks: requirement items (file + item key), test step keys, and its Fixed cards' numbers. */
    record Asks(List<Item> items, List<String> steps, List<Integer> fixedCards) {
    }

    record Item(String fileName, String itemKey, String text) {
    }

    /** One judged card: PASS, FAIL or UNKNOWN, and why. */
    record Verdict(int cardNumber, String verdict, String summary) {
    }

    /** The host's own board ({@code viaSlug} null), or the host's board read through the link {@code viaSlug}. */
    Asks asks(String viaSlug, String boardId);

    /** The host's own marks, ticks and re-test verdicts, in the environment shapes (the host's column). */
    List<EnvMark> hostMarks(String boardId);

    List<EnvStep> hostSteps(String boardId);

    List<EnvRetest> hostRetests(String boardId);

    /** Creates a cycle in {@code project} named {@code name} and starts recording it; returns its id. */
    String startCycle(String project, String name);

    /** Links a cycle (local, or {@code id@slug}) to one of this Alfred's boards. */
    void linkCycle(String boardId, String cycleRef);

    /** Judges re-tests of the host's cards (read through {@code viaSlug}, or local when null) from one local cycle's calls. */
    List<Verdict> judge(String viaSlug, String boardId, List<Integer> cardNumbers, String cycleId);
}
