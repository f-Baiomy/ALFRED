package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardStatus;

import java.util.Set;

/**
 * What Claude may do on the board (FR-041, FR-042). New cards always land in the Inbox; Claude moves work only between
 * To do, In progress and Fixed; scope, Verified, Done, closing, reopening, deleting and checklist marks are the user's.
 * A guardrail against an agent going too far, not a security boundary (research R11).
 */
public final class ClaudeRules {

    public static final String USER_ONLY = "Only the user decides this - propose it in a comment";
    public static final String STRUCTURED_COMMENT = "Claude's comments need did, found and next - or a reply, or a question";
    public static final String OWN_INBOX_ONLY = "Claude edits only its own cards while they are in the Inbox - comment on this one instead";
    public static final String PROPOSE_ONLY = "Claude proposes this step; only the user accepts it";

    private static final Set<CardStatus> CLAUDE_TARGETS = Set.of(CardStatus.TO_DO, CardStatus.IN_PROGRESS, CardStatus.FIXED);
    private static final Set<CardStatus> USER_HELD = Set.of(CardStatus.VERIFIED, CardStatus.DONE, CardStatus.CLOSED);

    private ClaudeRules() {
    }

    public static boolean mayMove(CardStatus from, CardStatus to) {
        return CLAUDE_TARGETS.contains(to) && !USER_HELD.contains(from);
    }

    /** Claude rewrites a card's title, description or kind only while it is Claude's own and still waiting in the Inbox. */
    public static boolean mayEdit(Card card) {
        return card.author() == Actor.CLAUDE && card.status() == CardStatus.INBOX;
    }
}
