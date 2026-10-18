package com.fathy.alfred.backend.sessions.domain.model;

import java.time.Instant;

/**
 * Something the user asked one of their PCs to do from a browser (specs/031): start or resume a board's session, open it
 * in Claude Desktop or a terminal, stop it, pick a folder, bring a transcript, sync it. Queued for that PC's helper, which
 * claims it (waiting, never polling) and reports the outcome. Never a command line: the helper maps each kind to its own
 * fixed action.
 */
public record HelperCommand(String id, String helperKeyId, String user, Kind kind, String boardId, String project, String sessionId,
                            String args, State state, String result, Instant createdAt, Instant updatedAt) {

    public enum Kind { START, RESUME, OPEN_DESKTOP, OPEN_TERMINAL, STOP, STOP_ALL, PICK_FOLDER, BRING_TRANSCRIPT, SEND_TRANSCRIPT, SYNC,
        CONTINUE_FROM_COPY, ATTACH, LISTEN, STOP_LISTEN, HANDOVER, RESTART_DESKTOP, RELEASE }

    public enum State { QUEUED, TAKEN, DONE, FAILED, CANCELLED }

    public HelperCommand with(State s, String r, Instant at) {
        return new HelperCommand(id, helperKeyId, user, kind, boardId, project, sessionId, args, s, r, createdAt, at);
    }
}
