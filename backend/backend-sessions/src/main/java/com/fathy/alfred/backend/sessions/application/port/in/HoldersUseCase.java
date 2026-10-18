package com.fathy.alfred.backend.sessions.application.port.in;

import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Holder;
import com.fathy.alfred.backend.sessions.domain.model.PendingMessage;
import com.fathy.alfred.backend.sessions.domain.model.WriteDecision;

import java.util.List;
import java.util.Optional;

/**
 * The board lock (specs/031): one holder per board. Taking a free board is the holder's ▶ alfred-live or listen; another
 * user can only ask for it, and the holder hands it over, releases it or keeps it.
 */
public interface HoldersUseCase {

    Optional<Holder> holder(String boardId);

    List<Holder> holders(String project);

    /** The lock's answer for one write. {@code caller} empty: an unpaired browser or an old client. */
    WriteDecision mayWrite(Optional<Caller> caller, String boardId, WriteDecision.Kind kind);

    /** Takes a free board (or one held by the caller themself). Refused when another user holds it. */
    Result take(Caller caller, String boardId, String project, String sessionId);

    Result release(Caller caller, String boardId);

    /** Another user's ask for a held board, with a short note. */
    Result request(Caller caller, String boardId, String note);

    enum Answer { HAND_OVER, RELEASE, KEEP }

    /** The holder's answer to the open request. HAND_OVER makes the requester the holder at once. */
    Result answer(Caller caller, String boardId, Answer answer);

    /** The holder names who may chat and comment. */
    Result commenters(Caller caller, String boardId, List<String> users);

    /** A commenter's chat message, held until the holder lets Claude answer it. Refused for anyone not a commenter. */
    PendingOutcome submit(Caller caller, String boardId, String project, String scope, String text);

    /** The waiting messages: all of them for the holder, a commenter's own for a commenter. */
    List<PendingMessage> pending(Caller caller, String boardId);

    /** The holder lets Claude answer (the message is returned for their page to post) or declines; either way it leaves the queue. */
    PendingOutcome resolve(Caller caller, long id, boolean letClaudeAnswer);

    record PendingOutcome(PendingMessage message, String error, String text) {
    }

    /** The server admin's last resort; recorded in the board's audit. */
    Result forceRelease(String boardId);

    /** Frees every board a user holds (their key was revoked). Returns the boards. */
    List<String> releaseAllOf(String user, String why);

    record Result(Holder holder, String error, String message) {

        public static Result ok(Holder h) {
            return new Result(h, null, null);
        }

        public static Result refused(String error, String message) {
            return new Result(null, error, message);
        }

        public boolean ok() {
            return error == null;
        }
    }
}
