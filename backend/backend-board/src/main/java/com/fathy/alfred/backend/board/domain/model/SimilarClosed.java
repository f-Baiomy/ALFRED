package com.fathy.alfred.backend.board.domain.model;

/** A closed card an Inbox card resembles (same signature): shown as a hint so the user can decide in a second. */
public record SimilarClosed(int number, String title, Resolution resolution, String reason) {
}
