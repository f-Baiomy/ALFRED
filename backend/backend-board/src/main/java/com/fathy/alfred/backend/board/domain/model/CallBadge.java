package com.fathy.alfred.backend.board.domain.model;

/** A card shown on a call row: number, kind and state. */
public record CallBadge(String project, int number, CardKind kind, CardStatus status, Resolution resolution) {
}
