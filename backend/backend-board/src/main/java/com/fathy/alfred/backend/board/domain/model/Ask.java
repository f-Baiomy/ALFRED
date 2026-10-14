package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A question for Claude asked from the board (specs/017 R24, R38): {@code alfred.ask()} in a snippet, or ✦ Ask Claude
 * in the editor over selected text. It goes to the cycle's chat as a skill run ({@code /alfred-ask <id>}); Claude reads
 * it with {@code board_ask_get} and answers with {@code board_ask_answer}, and the page that asked hears the answer on
 * /ws/board ({@code ask:<id>}). {@code data} is JSON text the asker attached (the selection, a snippet's numbers).
 */
public record Ask(String id, String project, String cycleId, String cardId, Integer cardNumber, String snippetId, Kind kind, String question,
                  String data, State state, String answer, String runId, Instant createdAt, Instant answeredAt) {

    public enum Kind { SNIPPET, EDITOR }

    public enum State { OPEN, ANSWERED, CANCELLED }

    public static final int MAX_QUESTION = 4000;
    public static final int MAX_DATA_BYTES = 256 * 1024;
    public static final int MAX_ANSWER_BYTES = 256 * 1024;
}
