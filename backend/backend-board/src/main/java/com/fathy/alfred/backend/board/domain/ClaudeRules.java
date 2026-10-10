package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.CardStatus;

import java.util.Set;

/**
 * What Claude may do on the board (FR-041, FR-042). New cards always land in the Inbox; Claude moves work only between
 * To do, In progress and Fixed; scope, Verified, Done, closing, reopening, deleting and checklist marks are the user's.
 * A guardrail against an agent going too far, not a security boundary (research R11).
 */
public final class ClaudeRules {

    public static final String USER_ONLY = "Only the user decides this - propose it in a comment";
    public static final String STRUCTURED_COMMENT = "Claude's comments need did, found and next";

    private static final Set<CardStatus> CLAUDE_TARGETS = Set.of(CardStatus.TO_DO, CardStatus.IN_PROGRESS, CardStatus.FIXED);
    private static final Set<CardStatus> USER_HELD = Set.of(CardStatus.VERIFIED, CardStatus.DONE, CardStatus.CLOSED);

    private ClaudeRules() {
    }

    public static boolean mayMove(CardStatus from, CardStatus to) {
        return CLAUDE_TARGETS.contains(to) && !USER_HELD.contains(from);
    }
}
