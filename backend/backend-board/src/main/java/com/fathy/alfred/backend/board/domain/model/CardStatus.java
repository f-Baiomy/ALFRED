package com.fathy.alfred.backend.board.domain.model;

/** The board's columns. CLOSED carries a Resolution; the others are open. */
public enum CardStatus {
    INBOX, TO_DO, IN_PROGRESS, FIXED, VERIFIED, DONE, CLOSED
}
