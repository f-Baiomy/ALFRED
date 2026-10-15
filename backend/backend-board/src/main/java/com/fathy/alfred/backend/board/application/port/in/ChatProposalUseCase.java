package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;

import java.util.List;
import java.util.Map;

/**
 * Claude's proposals in a chat answer (specs/022 FR-026, FR-046): verify, close as Fine, move, a checklist mark, a new
 * acceptance item. The user accepts or declines them one by one or in bulk; an accepted one is applied as the user's
 * action, after the board is checked again. Accepting offers Undo for 60 seconds.
 */
public interface ChatProposalUseCase {

    long UNDO_SECONDS = 60;

    /** {@code results}: per proposal id - "applied", "declined", "already done", "outdated: <why>" or why it failed. */
    record Outcome(Map<String, String> results, String undoToken) {
    }

    ChatUseCase.Result<Outcome> decide(Actor actor, long messageId, List<String> accept, List<String> decline);

    /** Each open proposal checked against the board now: null when it can be accepted, else "already done" / "outdated: <why>". */
    ChatUseCase.Result<Map<String, String>> check(long messageId);

    /** Restores what an accept changed and reopens its proposals - within {@link #UNDO_SECONDS} of the accept. */
    ChatUseCase.Result<Void> undo(Actor actor, String token);

    /** Records the user's yes or no on a consent (a resend, a rule) - the frontend runs it through the consent dialog. */
    ChatUseCase.Result<Void> consent(Actor actor, long messageId, boolean yes);
}
