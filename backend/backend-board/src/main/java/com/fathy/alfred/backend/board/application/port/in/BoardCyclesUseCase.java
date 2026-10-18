package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.RetestCheck;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * A board's Cycles tab (specs/033): its cycles with what the board keeps about each (kind, ⚑ baseline, archived) and the
 * cards each re-test tests with their verdict in it; a card's verdict in every cycle that checked it; the board's
 * flags on a cycle.
 */
public interface BoardCyclesUseCase {

    /** One card a cycle tests, with its verdict in that cycle (null when it was not checked). */
    record TestedCard(String cardId, int number, String title, CardStatus status, RetestCheck.Verdict verdict, String summary) {
    }

    /** One cycle of the board. {@code tests}: the cards related to the cycle; {@code kind} REC / RETEST / null. */
    record CycleRow(String cycleId, String kind, boolean baseline, boolean archived, Instant relatedAt, List<TestedCard> tests,
                    List<String> otherBoards) {
    }

    /** The card's verdict in one cycle. */
    record CycleVerdict(String cycleId, String name, boolean home, RetestCheck.Verdict verdict, int calls, String summary) {
    }

    record Flags(Boolean baseline, Boolean archived) {
    }

    enum Outcome { OK, NOT_FOUND, REFUSED }

    /** Empty when the board does not exist. */
    Optional<List<CycleRow>> cycles(String boardId);

    /** Every cycle the card is checked in - its home cycle and the cycles related to it. Empty when the card does not exist. */
    Optional<List<CycleVerdict>> timeline(String cardId);

    /** The board's ⚑ baseline / archived on one of its cycles - the user's choice: Claude is refused. */
    Outcome setFlags(Actor actor, String boardId, String cycleId, Flags flags);

    /** Whether Claude writes a summary when one of the board's recordings pauses (on unless the user switched it off). */
    boolean claudeSummaries(String boardId);

    /** The user switches Claude's cycle summaries on or off for the board; Claude is refused. */
    Outcome setClaudeSummaries(Actor actor, String boardId, boolean on);
}
