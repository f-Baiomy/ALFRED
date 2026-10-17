package com.fathy.alfred.backend.board.domain.model;

/** What a board change ended with (specs/027 contracts/board-rest.md). */
public enum BoardOutcome {
    OK,
    NOT_FOUND,
    /** A default board cannot be archived, marked done or deleted. */
    DEFAULT_PROTECTED,
    /** Claude may not do this (FR-001b). */
    REFUSED_FOR_CLAUDE,
    /** Claude opened a board without naming the user's asking message (FR-040). */
    NOT_ASKED,
    /** Through the tunnel, or another access rule. */
    REFUSED
}
