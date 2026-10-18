package com.fathy.alfred.backend.sessions.application.port.in;

import com.fathy.alfred.backend.sessions.domain.model.AuditEntry;
import com.fathy.alfred.backend.sessions.domain.model.BoardSession;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.HelperCommand;

import java.util.List;
import java.util.Optional;

/**
 * The boards' Claude sessions and the commands that drive them (specs/031). Sessions are reported by the helper that runs
 * them; commands are queued by the user from a browser for one of their own PCs.
 */
public interface SessionsUseCase {

    /** The helper's report of one session as it is now; the first report of a board's session makes it the current one. */
    BoardSession report(Caller helper, Report report);

    record Report(String id, String boardId, String project, String cliSessionId, String desktopId, String cwd, String title,
                  BoardSession.State state, BoardSession.OpenIn openIn, Long lastChatSeq, Long tokensToday, Boolean makeCurrent) {
    }

    List<BoardSession> sessions(String project, String boardId, int limit);

    Optional<BoardSession> current(String boardId);

    /** A user asks one of their own PCs to do something. Refused for another user's PC. */
    CommandOutcome queue(Caller caller, String helperKeyId, HelperCommand.Kind kind, String boardId, String project, String sessionId,
                         String args);

    record CommandOutcome(HelperCommand command, String error, String message) {
    }

    List<HelperCommand> commands(Caller caller, int limit);

    /** The helper takes its queued commands (TAKEN). */
    List<HelperCommand> claim(Caller helper, int max);

    /** Wakes {@code listener} when a command is queued for any helper; close to stop listening. */
    AutoCloseable onQueued(Runnable listener);

    Optional<HelperCommand> report(Caller helper, String id, HelperCommand.State state, String result);

    Optional<HelperCommand> cancel(Caller caller, String id);

    /** A board write, for the audit: who, from where, through what. */
    void audit(String boardId, String what, Optional<Caller> caller, String via);

    List<AuditEntry> audit(String boardId, int limit);
}
