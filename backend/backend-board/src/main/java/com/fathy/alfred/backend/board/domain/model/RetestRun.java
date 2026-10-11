package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * One recorded re-test of a card (specs/016 FR-12): when, by whom, from what ({@code live} calls or {@code cycle:<id>}),
 * the verdict, how many calls, and the one-line summary ("257 → 3 queries on TT_COUNTRY_AIRLINE_MAP").
 */
public record RetestRun(long id, String cardId, int number, Instant at, Actor actor, String source, RetestCheck.Verdict verdict,
                        int calls, String summary) {
}
