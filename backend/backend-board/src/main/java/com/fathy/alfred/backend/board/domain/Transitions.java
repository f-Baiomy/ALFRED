package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.CardStatus;

/**
 * Which status changes the board allows (data-model.md "State transitions"). Moves happen between open statuses;
 * CLOSED is reached only by a close (which needs a resolution) and left only by a reopen (back to INBOX).
 */
public final class Transitions {

    private Transitions() {
    }

    public static boolean canMove(CardStatus from, CardStatus to) {
        return from != CardStatus.CLOSED && to != CardStatus.CLOSED && from != to;
    }

    public static boolean canClose(CardStatus from) {
        return from != CardStatus.CLOSED;
    }

    public static boolean canReopen(CardStatus from) {
        return from == CardStatus.CLOSED;
    }
}
