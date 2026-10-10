package com.fathy.alfred.backend.board.domain.model;

/** A card shown on a call row: number, kind, state and title. */
public record CallBadge(String project, int number, CardKind kind, CardStatus status, Resolution resolution, String title) {

    public CallBadge(String project, int number, CardKind kind, CardStatus status, Resolution resolution) {
        this(project, number, kind, status, resolution, null);
    }
}
