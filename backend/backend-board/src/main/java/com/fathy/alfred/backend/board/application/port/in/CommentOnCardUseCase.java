package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;

/** Posts a comment. A Claude comment must say what it did, found and will do next (FR-029). */
public interface CommentOnCardUseCase {

    record Comment(String text, String did, String found, String next, String impact) {
    }

    record CommentOutcome(CardChange.Outcome outcome, ActivityEntry entry, String message) {
    }

    CommentOutcome comment(Actor actor, String id, Comment comment);
}
