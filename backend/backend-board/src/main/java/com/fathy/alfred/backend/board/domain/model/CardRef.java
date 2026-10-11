package com.fathy.alfred.backend.board.domain.model;

/** Another card, as a line: project, number, title and status (a blocker, a card about a spec item). */
public record CardRef(String project, int number, String title, CardStatus status) {
}
