package com.fathy.alfred.backend.board.domain.model;

/** Who a card waits on: the user (a question, a proposal, sorting), Claude (work to do), a re-test, or nobody. */
public enum Waiting {
    USER, CLAUDE, RETEST, NONE
}
