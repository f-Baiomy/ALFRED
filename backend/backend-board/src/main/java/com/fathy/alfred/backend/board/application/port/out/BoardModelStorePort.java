package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardActivity;
import com.fathy.alfred.backend.board.domain.model.BoardState;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Boards, their relations to session cycles and to each other, card homes and related cycles, and board activity
 * (specs/027 data-model.md). Cycle ids are plain strings: the board slice never depends on the session-cycles slice.
 */
public interface BoardModelStorePort {

    Optional<Board> board(String id);

    /** Boards of a project (all projects when null) in the given states, name containing {@code q}; at most {@code limit}. */
    List<Board> boards(String project, Set<BoardState> states, String q, int limit);

    /** Inserts or replaces the board. */
    void putBoard(Board board);

    /** Deletes the board: its cards move to {@code moveCardsTo}, its relations and activity go with it. */
    void deleteBoard(String id, String moveCardsTo);

    /** Card counts per board id (cards homed there). */
    Map<String, Integer> cardCounts(Collection<String> boardIds);

    // ------------------------------------------------------------------------------------------------ relations

    /** True when the relation was new. */
    boolean relateCycle(String boardId, String cycleId, Actor by, Instant at);

    boolean unrelateCycle(String boardId, String cycleId);

    List<String> cyclesOf(String boardId);

    List<String> boardsOfCycle(String cycleId);

    /** The board's cycles with what the board keeps about each (specs/033), oldest relation first. */
    default List<com.fathy.alfred.backend.board.domain.model.BoardCycleLink> cycleLinks(String boardId) {
        return cyclesOf(boardId).stream().map(id -> new com.fathy.alfred.backend.board.domain.model.BoardCycleLink(id, null, false, false, null)).toList();
    }

    /** REC or RETEST - what the board recorded the cycle for. */
    default boolean setCycleKind(String boardId, String cycleId, String kind) {
        return false;
    }

    /** null leaves a flag as it is; a baseline set clears the board's other one. True when the relation exists. */
    default boolean setCycleFlags(String boardId, String cycleId, Boolean baseline, Boolean archived) {
        return false;
    }

    /** Removes a board_meta key (a board preference switched back). */
    default void unmark(String key) {
    }

    /** The cards related to a cycle (beyond their home cycle). */
    default List<String> cardsOfCycle(String cycleId) {
        return List.of();
    }

    boolean relateBoards(String a, String b);

    boolean unrelateBoards(String a, String b);

    List<String> relatedBoards(String boardId);

    // ------------------------------------------------------------------------------------------------ card homes

    /** Moves a card's home; false when no such card. */
    boolean setHome(String cardId, String boardId, Instant at, Actor by);

    boolean relateCardCycle(String cardId, String cycleId);

    boolean unrelateCardCycle(String cardId, String cycleId);

    List<String> cardCycles(String cardId);

    /**
     * A session cycle was deleted: it leaves every board and card, and the cards found in it are marked "origin deleted".
     */
    void cycleGone(String cycleId);

    // ------------------------------------------------------------------------------------------------ activity

    /** Appends one row and keeps at most {@code keep} per board (oldest trimmed). Returns its id. */
    long addActivity(BoardActivity entry, int keep);

    List<BoardActivity> activity(String boardId, long after, int limit);

    Optional<BoardActivity> activityEntry(long id);

    /** Marks the entry undone once: false when it already was (a second click, or Claude and the user at once). */
    boolean markUndone(long id, Instant at);

    // ------------------------------------------------------------------------------------------------ migration

    /** A one-time step already done (board_meta). */
    boolean done(String step);

    void markDone(String step);

    /** Every distinct project with cards or chat messages. */
    List<String> knownProjects();

    /** A call of a session cycle some board text mentions: the board it is on (null when none says), the card (0 when none). */
    record CycleMention(String callId, String boardId, int cardNumber) {
    }

    /** Every mention of a call captured in {@code cycleId} (specs/027 FR-017), at most 100,000. */
    List<CycleMention> mentionsInCycle(String cycleId);

    /** Task keys (old cycle ids) that hold a brief, spec files, evidence or a chat - what becomes a board. */
    List<String> briefedTaskKeys();

    /** The project a task key's cards or chat belong to; empty when it has none. */
    Optional<String> projectOfTaskKey(String taskKey);

    /** Cycle ids cards name as their origin, per project. */
    Map<String, List<String>> originCyclesByProject();

    /** Moves every card whose cycle is {@code taskKey} home to that board. */
    int homeCardsOfTaskKey(String taskKey, String project);
}
