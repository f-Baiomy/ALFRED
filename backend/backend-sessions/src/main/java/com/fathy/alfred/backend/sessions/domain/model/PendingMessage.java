package com.fathy.alfred.backend.sessions.domain.model;

import java.time.Instant;

/**
 * A commenter's chat message on a held board (specs/031): it waits here until the holder lets Claude answer it (their
 * page then posts it to the board's chat, quoted with who wrote it) or declines it. Claude never sees it before.
 */
public record PendingMessage(long id, String boardId, String project, String scope, String user, String machine, String text, Instant at) {
}
