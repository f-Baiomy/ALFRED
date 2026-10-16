package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;
import java.util.Locale;

/**
 * Is a card's fix implemented (specs/026)? What Claude found in the code and git - Alfred cannot read either - kept
 * beside the re-test of the calls ("did it work"): a Fixed card is ready for Verified only when both hold.
 * <ul>
 *   <li>IMPLEMENTED - the fix's commit is on the task branch and in the running build, every layer the card's teams
 *       own has its change, nothing reverted it (and its tests pass, when they were run);</li>
 *   <li>NOT_ON_BRANCH, NOT_IN_BUILD, LAYER_MISSING, REVERTED, TESTS_FAIL - what is not;</li>
 *   <li>UNKNOWN - the code could not be reached (a repo not in the session).</li>
 * </ul>
 * {@code verdict} is plain text read leniently (never an enum: an older Alfred must not throw on a new one).
 */
public record CodeCheck(String cardId, int number, String verdict, String commit, String branch, List<Layer> layers, String tests, String note,
                        Instant at, Actor by) {

    public static final List<String> VERDICTS = List.of("IMPLEMENTED", "NOT_ON_BRANCH", "NOT_IN_BUILD", "LAYER_MISSING", "REVERTED", "TESTS_FAIL",
            "UNKNOWN");

    public CodeCheck {
        layers = layers == null ? List.of() : List.copyOf(layers);
        verdict = verdict == null ? "UNKNOWN" : verdict.strip().toUpperCase(Locale.ROOT);
    }

    public boolean implemented() {
        return "IMPLEMENTED".equals(verdict);
    }

    /** One layer of the fix: the team that owns it, where its change is ("RefundSearchService.java:88"), found or not. */
    public record Layer(String team, String where, boolean ok, String note) {
    }
}
