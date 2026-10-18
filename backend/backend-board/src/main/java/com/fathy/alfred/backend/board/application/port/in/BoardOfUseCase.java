package com.fathy.alfred.backend.board.application.port.in;

import java.util.Optional;

/**
 * Which board a board object belongs to (specs/031): the board lock asks it for the board of a write that names only a
 * card, a chat message, a snippet, a file or an ask. Empty when the object is unknown - the write then goes on to its own
 * not-found answer.
 */
public interface BoardOfUseCase {

    Optional<String> boardOfCard(String cardId);

    Optional<String> boardOfCardNumber(String project, int number);

    /** A chat message's board: its board chat's board, or {@code default:<project>} for the project chat. */
    Optional<String> boardOfChatMessage(long messageId);

    Optional<String> boardOfSnippet(String snippetId);

    Optional<String> boardOfFile(String fileId);

    Optional<String> boardOfAsk(String askId);

    /** A chat record's board (its message's). */
    Optional<String> boardOfChatRecord(long recordId);

    /** A skill run's board (its cycle's, else its project's default board). */
    Optional<String> boardOfRun(String runId);

    /** The board of a chat named by its wire scope ("project" or a board id). */
    String boardOfChat(String project, String scope);
}
