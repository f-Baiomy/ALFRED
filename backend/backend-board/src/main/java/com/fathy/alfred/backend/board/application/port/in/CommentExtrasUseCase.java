package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.TextVersion;

import java.util.List;
import java.util.Set;

/**
 * What a comment gets beyond being written (docs/board.md "Rich text"): reactions - one click instead of a comment, ✅ Go
 * on Claude's plan is the user's go-ahead - and editing the user's own comments, with the earlier texts kept.
 */
public interface CommentExtrasUseCase {

    /** The reactions a comment can get. */
    Set<String> REACTIONS = Set.of("👍", "✅", "🤔", "👀", "🎉", "❌");
    /** The reaction that answers Claude's plan or question with "go". */
    String GO = "✅";

    record Outcome(CardChange.Outcome outcome, String message, boolean on) {
    }

    /** Toggles the user's reaction on a comment: on when it was off, off when it was on. */
    Outcome react(Actor actor, String cardId, long commentId, String emoji);

    /** The user edits their own comment; the earlier text is kept as a version. */
    Outcome editComment(Actor actor, String cardId, long commentId, String text);

    /** Earlier texts of {@code comment:<id>} or {@code description:<card id>}, newest first. */
    List<TextVersion> versions(String owner);
}
