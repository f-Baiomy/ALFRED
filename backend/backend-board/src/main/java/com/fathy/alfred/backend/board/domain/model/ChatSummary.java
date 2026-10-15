package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * One row of the chats bar (specs/022 FR-017, FR-039): the chat's newest message in a line, how many of the user's
 * messages wait, and what waits on the user. {@code lastPreview} is plain text, never a folded body.
 */
public record ChatSummary(String project, String scope, String name, boolean cycle, Long lastId, Instant lastAt, String lastPreview,
                          String lastAuthor, int waiting, int questions, int proposals, int confirms) {

    /** The preview the bar shows - one line, at most this long. */
    public static final int PREVIEW = 140;

    public boolean needsYou() {
        return questions + proposals + confirms > 0;
    }
}
