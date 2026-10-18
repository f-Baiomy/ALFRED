package com.fathy.alfred.backend.sessions.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * Who holds a board (specs/031): only this user writes on it - chat, comments, cards, brief, spec, runs and their Claude -
 * until they release or hand it over. {@code commenters} may still send chat messages and comments, which wait for the
 * holder's OK before Claude answers them. {@code request} is another user's open ask for the board, if any.
 */
public record Holder(String boardId, String project, String user, String machine, String sessionId, Instant since, List<String> commenters,
                     Request request) {

    public Holder {
        commenters = commenters == null ? List.of() : List.copyOf(commenters);
    }

    public record Request(String user, String machine, String note, Instant at) {
    }

    public Holder withRequest(Request r) {
        return new Holder(boardId, project, user, machine, sessionId, since, commenters, r);
    }

    public Holder withCommenters(List<String> c) {
        return new Holder(boardId, project, user, machine, sessionId, since, c, request);
    }

    public Holder withSession(String machine, String sessionId) {
        return new Holder(boardId, project, user, machine, sessionId, since, commenters, request);
    }
}
