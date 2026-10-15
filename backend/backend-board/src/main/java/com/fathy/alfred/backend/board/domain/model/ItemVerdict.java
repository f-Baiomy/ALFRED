package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.Locale;

/**
 * Where one Acceptance item stands by the calls (specs/018), worked out in code from each call to its endpoint:
 * the verdict, the call that decided it, why (the failing check and the value seen), and the card about it.
 */
public record ItemVerdict(String cycleId, String fileName, String itemKey, Verdict verdict, String callId, String reason,
                          Counts counts, String cardId, Instant judgedAt) {

    /** The item, worst first: a call that cannot meet it, a call whose response breaks it, ... no evidence at all. */
    public enum Verdict {
        MISSING, WRONG, MET, NO_DATA, UNKNOWN, NOT_EXERCISED, MANUAL, NO_EVIDENCE;

        /** Read back from storage: an unknown value (a later Alfred's) is UNKNOWN, never an error. */
        public static Verdict parse(String s) {
            try {
                return s == null ? UNKNOWN : valueOf(s.strip().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                return UNKNOWN;
            }
        }
    }

    /** What one call showed about an item; SKIPPED - the call was about another choice (kept so it is read once). */
    public enum CallResult {
        CONTRADICTS, WRONG, NO_DATA, MEETS, UNKNOWN, SKIPPED;

        public static CallResult parse(String s) {
            try {
                return s == null ? UNKNOWN : valueOf(s.strip().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                return UNKNOWN;
            }
        }

        /** The item verdict a set of results gives (worst wins); NOT_EXERCISED when there is none. */
        public Verdict verdict() {
            return switch (this) {
                case CONTRADICTS -> Verdict.MISSING;
                case WRONG -> Verdict.WRONG;
                case MEETS -> Verdict.MET;
                case NO_DATA -> Verdict.NO_DATA;
                case UNKNOWN -> Verdict.UNKNOWN;
                case SKIPPED -> Verdict.NOT_EXERCISED;
            };
        }
    }

    /**
     * How many calls in the item's window gave each result; {@code skipped}: calls to the item's endpoint its REQUEST_WHEN
     * left out as another choice (specs/020) - with none judged the item is NOT_EXERCISED, but the endpoint WAS called:
     * check the evidence (an app's own "all" marker such as -11 needs has:-11) before saying nobody tried it.
     */
    public record Counts(int contradicts, int wrong, int meets, int noData, int unknown, int skipped) {
        public static final Counts NONE = new Counts(0, 0, 0, 0, 0, 0);

        public Counts(int contradicts, int wrong, int meets, int noData, int unknown) {
            this(contradicts, wrong, meets, noData, unknown, 0);
        }

        public int total() {
            return contradicts + wrong + meets + noData + unknown;
        }
    }
}
