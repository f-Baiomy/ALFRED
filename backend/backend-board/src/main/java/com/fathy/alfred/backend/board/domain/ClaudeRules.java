package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardStatus;

import java.util.Set;

/**
 * What Claude may do on the board (FR-041, FR-042). New cards always land in the Inbox; Claude moves work only between
 * To do, In progress and Fixed; scope, Verified, Done, reopening and checklist marks are the user's, and closing or
 * deleting too - except an Inbox card, which Claude may close (saying why) or delete.
 * A guardrail against an agent going too far, not a security boundary (research R11).
 */
public final class ClaudeRules {

    public static final String USER_ONLY = "Only the user decides this - propose it in a comment";
    public static final String STRUCTURED_COMMENT = "Claude's comments need did, found and next - or a reply, or a question";
    public static final String OWN_INBOX_ONLY = "Claude edits only its own cards while they are in the Inbox - comment on this one instead";
    public static final String PROPOSE_ONLY = "Claude proposes this step; only the user accepts it";
    public static final String INBOX_ONLY = "Claude closes or deletes only Inbox cards - propose it on this one instead";
    public static final String SAY_WHY = "Say why you close it (reason) - the user reads it on the card";
    public static final String MERGE_INSTEAD = "A duplicate is merged - propose the merge instead";

    /** Claude may close (with a reason) or delete a card while it is in the Inbox, nowhere else (2026-10-20). */
    public static boolean mayCloseOrDelete(Card card) {
        return card.status() == CardStatus.INBOX;
    }

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
