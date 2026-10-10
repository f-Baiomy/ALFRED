package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/**
 * Posts a comment. A Claude comment must say what it did, found and will do next (FR-029) - or be a reply to the
 * user, or a question for the user (which flags the card Needs decision).
 */
public interface CommentOnCardUseCase {

    record Comment(String text, String did, String found, String next, String impact, String reply, String question) {

        public Comment(String text, String did, String found, String next, String impact) {
            this(text, did, found, next, impact, null, null);
        }
    }

    record CommentOutcome(CardChange.Outcome outcome, ActivityEntry entry, String message) {
    }

    CommentOutcome comment(Actor actor, String id, Comment comment);
}
