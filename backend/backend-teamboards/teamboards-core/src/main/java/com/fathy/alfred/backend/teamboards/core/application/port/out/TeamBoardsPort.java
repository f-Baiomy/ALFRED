package com.fathy.alfred.backend.teamboards.core.application.port.out;

import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * What the Team slice asks of Alfred's boards and cards (specs/027 US8, 028 US2-US6), implemented by
 * backend-app/teamboardsbridge. Absent when the bridge is not wired: then nothing Team-side touches a board.
 */
public interface TeamBoardsPort {

    /** Whether Alfred knows the project (a project it fronts, or one with boards) - a start never goes to a typo. */
    boolean projectExists(String project);

    /**
     * Who will answer a start posted there now: "the terminal holding <board>", "the project's live runner", or null
     * when nobody is live - the message then waits until someone starts /alfred-live.
     */
    String whoAnswers(String project, String boardId);

    /** The board's project, or empty when there is no such board. */
    Optional<String> projectOf(String boardId);

    /** The board's name (its title), or empty when there is no such board. */
    default Optional<String> boardName(String boardId) {
        return projectOf(boardId);
    }

    /**
     * Posts the user's start as a waiting message in a board's chat ({@code boardId} null: the project's default board),
     * so the terminal holding it, or the project's runner, runs /alfred-setup. The message id, or empty when not posted.
     */
    Optional<Long> postStart(String project, String boardId, String text);

    /** A first cycle for a new board: none, one not recording yet, or one recording now (pausing the project's running one). */
    enum FirstCycle { NONE, NEW, RECORD }

    /** A board made from a work item: its id, or the board's reason in {@code why}. */
    record MadeBoard(String boardId, String why) {
    }

    /** Opens a board in {@code project} (as the user, or as Claude with {@code askedIn}). */
    default MadeBoard createBoard(String project, String name, FirstCycle cycle, boolean asClaude, String askedIn) {
        return new MadeBoard(null, "Boards are not available here");
    }

    /** Removes a board just made (its main link failed): nothing is left half made. */
    default void deleteBoard(String boardId) {
    }

    /** An open board of the project with exactly this name (any case), if there is one. */
    default Optional<String> boardNamed(String project, String name) {
        return Optional.empty();
    }

    /** Withdraws a waiting start's message (the user cancelled it before anyone took it). False when it was taken already. */
    boolean withdrawStart(long messageId);

    /** Whether {@code askedIn} names a request of the user: a USER chat message, or "terminal" (the board's own rule). */
    boolean askedBy(String askedIn);

    /** The names of the files a board already holds. */
    Set<String> files(String boardId);

    /** Attaches a file to a board as the user; null when stored, else why not (type, size, count). */
    String attach(String boardId, String name, byte[] data);

    // ---------------------------------------------------------------------------------------------------------- cards

    /** A card as the Team slice needs it. {@code status}: INBOX ... CLOSED; {@code resolution} only when closed. */
    record CardInfo(String id, String boardId, String project, int number, String kind, String title, String description, String status,
                    String resolution) {
    }

    default Optional<CardInfo> card(String cardId) {
        return Optional.empty();
    }

    /** A board's open cards (newest first), for "Link to card…". */
    default List<CardInfo> cardsOfBoard(String boardId, int limit) {
        return List.of();
    }

    /** A card that looks like {@code title}/{@code text}: on this board first, then the project's; {@code score} 0..100. */
    record Similar(CardInfo card, int score, String why) {
    }

    default List<Similar> similar(String boardId, String title, String text, int limit) {
        return List.of();
    }

    /**
     * A new card on a board (FR-055): as the user, or as Claude (then it lands in the Inbox like every Claude card).
     * {@code kind} BUG, TASK, NOTE or QUESTION. The new card's id, or empty with the board's reason in {@code why[0]}.
     */
    default Optional<String> createCard(String boardId, boolean asClaude, String kind, String title, String description, String[] why) {
        return Optional.empty();
    }

    /** Adds a line to a card's description as the user (a work item pill, FR-051). False when the card is gone. */
    default boolean appendToDescription(String cardId, String text) {
        return false;
    }

    /** Claude proposes a status step on a card (Verified, Done, CLOSED with resolution) through the board's proposals. */
    default boolean propose(String cardId, String status, String resolution, String reason) {
        return false;
    }

    /** Claude proposes reopening a finished card (its Azure item was reopened). */
    default boolean proposeReopen(String cardId, String reason) {
        return false;
    }

    /** Cards that mention a person ({@code @[person:<conn>/<id>|…]}) or are owned by them: ids, per board. */
    record PersonCards(List<CardInfo> owned, List<CardInfo> mentioning) {
    }

    default PersonCards cardsOf(String conn, String personId, int limit) {
        return new PersonCards(List.of(), List.of());
    }
}
