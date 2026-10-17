package com.fathy.alfred.backend.teamboards.core.application.port.in;

import java.util.List;

/**
 * Start (specs/027 US8, 028 FR-114): the user opens an Alfred board from a work item. Only the user starts - from the
 * Team tab, a board chat or the terminal; Claude may suggest, never start. The start is a waiting /alfred-setup message
 * in the target board's chat; when /alfred-setup links the board (team_link), the item becomes the board's main.
 */
public interface StartFromItemUseCase {

    enum StartOutcome { WAITING, NEEDS_TARGET, ALREADY_STARTED, NOT_FOUND, INVALID }

    /** Where the board goes; {@code remember} saves it as the mapping for the item's sprint, squad, area or project. */
    record Target(String project, String boardId, boolean remember) {
    }

    /** {@code answeredBy}: who will run /alfred-setup now (null: nobody is live - it waits). */
    record StartResult(StartOutcome outcome, String project, String boardId, Long messageId, String suggestedProject, String message,
                       int attachmentsFetched, String answeredBy) {
        public static StartResult of(StartOutcome outcome, String message) {
            return new StartResult(outcome, null, null, null, null, message, 0, null);
        }
    }

    /** With the vault's token: reads the item live and downloads its attachments for the board (within the caps). */
    StartResult start(String conn, String extId, Target target);

    enum CancelOutcome { CANCELLED, NOT_WAITING, TAKEN }

    CancelOutcome cancel(String conn, String extId);

    /** A start of this item waits for /alfred-setup (what lets Claude link the board it sets up). */
    boolean isWaiting(String conn, String extId);

    /** Whether {@code askedIn} names a request of the user (a USER chat message, or "terminal"). */
    boolean askedByUser(String askedIn);

    /** Where an item's board would go without asking: its mapping, or null. */
    Target targetOf(String conn, String extId);

    /** {@code attached}: files now on the board; {@code notAttached}: name and why. */
    record LinkResult(List<String> attached, List<String> notAttached) {
    }

    /** /alfred-setup links the board: the item becomes its main, the start is done, its fetched files go to the board. */
    LinkResult link(String boardId, String conn, String extId);

    /**
     * As Claude (/alfred-setup's team_link): only onto the board the start was posted for (its project, and its board
     * when the start named one), and only a board with no main or with this item as its main.
     */
    default LinkResult link(com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who who, String boardId, String conn, String extId) {
        return link(boardId, conn, extId);
    }

    /** Downloads the main item's attachments the board does not hold yet (vault token). */
    LinkResult fetchAttachments(String boardId);
}
