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

    public boolean terminalMovedOn() {
        return terminalAt != null && (seenUpTo == null || terminalAt.isAfter(seenUpTo));
    }
}
