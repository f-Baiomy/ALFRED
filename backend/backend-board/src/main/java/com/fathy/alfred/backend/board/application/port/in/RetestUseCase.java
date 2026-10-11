package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.Expectation;
import com.fathy.alfred.backend.board.domain.model.RetestCheck;
import com.fathy.alfred.backend.board.domain.model.RetestPlan;
import com.fathy.alfred.backend.board.domain.model.RetestRun;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Re-testing fixes without a hassle (specs/016): a card's plan (expectations + steps), the check of its calls since the
 * fix or in a re-test cycle, guards on Verified / Done cards, the history of recorded re-tests, and the report.
 */
public interface RetestUseCase {

    int MAX_CARDS = 100;

    /** The card's plan; an empty plan when none was written. */
    RetestPlan plan(String cardId);

    /** Replaces the card's plan. Claude may not change the plan of a Done or closed card. */
    PlanChange setPlan(Actor actor, String cardId, List<Expectation> expectations, List<RetestPlan.Step> steps);

    /**
     * The Fixed cards of a project checked - all of them, or only {@code numbers} - against the live calls since each fix,
     * or only against a re-test cycle's calls when {@code cycleId} is given.
     */
    List<RetestCheck> check(String project, List<Integer> numbers, String cycleId);

    /** {@link #check} and one history entry per card checked; the report is built from the result. */
    Report run(Actor actor, String project, List<Integer> numbers, String cycleId);

    /** One card checked, whatever its status (the drawer), live or against a cycle. Empty when the card does not exist. */
    Optional<RetestCheck> checkCard(String cardId, String cycleId);

    /** Verified and Done cards with expectations, checked against the live calls since they got there (FR-10). */
    List<RetestCheck> guards(String project);

    List<RetestRun> history(String cardId);

    /** When the project's app last started, if Alfred saw it. */
    Optional<Instant> lastStart(String project);

    record PlanChange(CardChange.Outcome outcome, RetestPlan plan, String message) {
    }

    /** A recorded re-test of several cards: each card's check, and the report as Markdown. */
    record Report(Instant at, String source, List<RetestCheck> checks, String markdown) {
    }
}
