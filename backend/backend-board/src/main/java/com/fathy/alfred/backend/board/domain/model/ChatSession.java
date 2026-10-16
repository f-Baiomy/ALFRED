package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * The chat's own Claude Code session (specs/022 research R3, R4) as the runner keeps it: a fork of the terminal session
 * ({@code forkedFrom}) - or its own session when there is none - on {@code host}. Alfred only stores these strings; the
 * session itself lives on that machine. {@code seenUpTo} is the terminal work the copy holds, {@code terminalAt} the
 * latest significant terminal work the runner saw: later than {@code seenUpTo} means "terminal moved on".
 */
public record ChatSession(ChatKey chat, String chatSessionId, String forkedFrom, String host, Instant forkedAt, Instant seenUpTo,
                          Instant terminalAt) {

    /**
     * The terminal session itself answers the chat (plan-terminal-answers.md): its id is both the chat's session and the one
     * it is "from" - there is no copy, so nothing to catch up and nothing to mirror back to it.
     */
    public boolean answeredByTerminal() {
        return chatSessionId != null && chatSessionId.equals(forkedFrom);
    }

    public boolean terminalMovedOn() {
        return !answeredByTerminal() && terminalAt != null && (seenUpTo == null || terminalAt.isAfter(seenUpTo));
    }
}
