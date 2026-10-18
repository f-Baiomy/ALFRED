package com.fathy.alfred.backend.sessions.domain.model;

import java.time.Instant;

/**
 * A Claude Code session that answers one board (specs/031) - or the project chat, whose board is {@code default:<project>}.
 * Reported by the helper on the PC it runs on: {@code cliSessionId} is the transcript's id ({@code claude --resume}),
 * {@code desktopId} its Claude Desktop row when it has one, {@code cwd} the folder (a board worktree) it works in.
 * {@code openIn} says where it runs interactively right now - while it is open there, that session answers the board
 * itself and the helper writes no turns into it (a second writer forks the transcript, spike S2). {@code current}: the
 * board's session that jobs go to; a board may have older ones.
 */
public record BoardSession(String id, String boardId, String project, String cliSessionId, String desktopId, String user, String machine,
                           String helperKeyId, String cwd, String title, State state, OpenIn openIn, long lastChatSeq, long tokensToday,
                           String tokensDay, boolean current, Instant createdAt, Instant lastActive) {

    public enum State { STARTING, ANSWERING, IDLE, WAITING_BUDGET, WAITING_LIMIT, STOPPED, GONE }

    public enum OpenIn { NONE, DESKTOP, TERMINAL }
}
