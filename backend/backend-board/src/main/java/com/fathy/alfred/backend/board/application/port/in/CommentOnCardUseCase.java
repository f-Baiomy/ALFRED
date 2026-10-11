package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.Waiting;

/**
 * Posts a comment. A Claude comment must say what it did, found and will do next (FR-029) - or be a reply to the
 * user, or a question for the user (which flags the card Needs decision).
 */
public interface CommentOnCardUseCase {

    /**
     * {@code replyTo}: the comment (history entry id) this one answers, or null. {@code clearDecision}: on the user's
     * answer to Claude's question, take the card's Needs decision flag off when no other question stays unanswered.
     */
    record Comment(String text, String did, String found, String next, String impact, String reply, String question,
                   Long replyTo, boolean clearDecision, Waiting waitingOn) {

        public Comment(String text, String did, String found, String next, String impact, String reply, String question,
                       Long replyTo, boolean clearDecision) {
            this(text, did, found, next, impact, reply, question, replyTo, clearDecision, null);
        }

        public Comment(String text, String did, String found, String next, String impact) {
            this(text, did, found, next, impact, null, null, null, false, null);
        }

        public Comment(String text, String did, String found, String next, String impact, String reply, String question) {
            this(text, did, found, next, impact, reply, question, null, false, null);
        }
    }

    record CommentOutcome(CardChange.Outcome outcome, ActivityEntry entry, String message) {
    }

    CommentOutcome comment(Actor actor, String id, Comment comment);
}
