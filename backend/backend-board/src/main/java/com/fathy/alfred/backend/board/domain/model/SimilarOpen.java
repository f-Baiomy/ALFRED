package com.fathy.alfred.backend.board.domain.model;

/** An open card (any status but Closed) with the same signature as the one shown: the same problem on the same endpoint is already being worked on. */
public record SimilarOpen(int number, String title, CardStatus status) {
}
