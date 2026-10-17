package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.spi.model.Token;

/**
 * Start (specs/027 US8): the user opens an Alfred board from a work item. Only the user starts - from the Team tab, a
 * board chat or the terminal; Claude may suggest, never start. The start is a waiting /alfred-setup message in the
 * target board's chat, answered by the terminal holding that board or the project's runner.
 */
public interface StartFromItemUseCase {

    enum StartOutcome { WAITING, NEEDS_TARGET, ALREADY_STARTED, NOT_FOUND, INVALID }

    /** Where the board goes; {@code remember} saves it as the mapping for the item's sprint, squad, area or project. */
    record Target(String project, String boardId, boolean remember) {
    }

    /** {@code suggestedProject}: with NEEDS_TARGET, a project the item's squad points to, else null. */
    /** {@code answeredBy}: who will run /alfred-setup now (null: nobody is live - it waits). */
    record StartResult(StartOutcome outcome, String project, String boardId, Long messageId, String suggestedProject, String message,
                       int attachmentsFetched, String answeredBy) {
        public StartResult(StartOutcome outcome, String project, String boardId, Long messageId, String suggestedProject, String message,
                           int attachmentsFetched) {
            this(outcome, project, boardId, messageId, suggestedProject, message, attachmentsFetched, null);
        }

        public static StartResult of(StartOutcome outcome, String message) {
            return new StartResult(outcome, null, null, null, null, message, 0, null);
        }
    }

    /** The token, when the browser has one, also downloads the item's attachments for the board (within the caps). */
    StartResult start(String conn, String extId, Target target, Token token);

    enum CancelOutcome { CANCELLED, NOT_WAITING, TAKEN }

    /** Cancels a start nobody took yet; TAKEN when the terminal or runner is already setting it up (it then goes on). */
    CancelOutcome cancel(String conn, String extId);

    /** A start of this item waits for /alfred-setup (what lets Claude link the board it sets up). */
    boolean isWaiting(String conn, String extId);

    /** Whether {@code askedIn} names a request of the user (a USER chat message, or "terminal"). */
    boolean askedByUser(String askedIn);

    /** Where an item's board would go without asking: its mapping, or null. */
    Target targetOf(String conn, String extId);
}
