package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BriefComment;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;

import java.util.List;

/**
 * Comments on a cycle's brief (specs/024): the user and Claude comment on a passage or on the whole brief and reply;
 * Claude may ask and may suggest a rewording; only the user resolves, reopens, applies or dismisses.
 */
public interface BriefCommentsUseCase {

    int MAX_TEXT = 16 * 1024;
    int MAX_QUOTE = 2000;

    /** What a new comment says. {@code replyTo} is any comment of the thread; {@code quote} is ignored on a reply. */
    record NewComment(String quote, String text, Long replyTo, boolean asks, String suggestFrom, String suggestTo) {
    }

    record CommentOutcome(CardChange.Outcome outcome, BriefComment comment, CycleBrief brief, String message) {

        public static CommentOutcome refused(CardChange.Outcome outcome, String message) {
            return new CommentOutcome(outcome, null, null, message);
        }
    }

    List<BriefComment> comments(String cycleId);

    CommentOutcome add(Actor actor, String cycleId, NewComment comment);

    /** Resolves ({@code resolved}) or reopens a thread - the user's call. */
    CommentOutcome resolve(Actor actor, String cycleId, long id, boolean resolved);

    /** Puts Claude's suggested rewording into the brief (through the brief's own save, so Restore previous undoes it). */
    CommentOutcome apply(Actor actor, String cycleId, long id);

    CommentOutcome dismiss(Actor actor, String cycleId, long id);
}
