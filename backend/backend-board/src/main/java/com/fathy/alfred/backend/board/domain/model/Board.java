package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A board: one task (specs/027). It holds the brief, spec files, Acceptance items, chat, Inbox and cards; the session
 * cycles related to it are its recordings and re-tests. {@code migratedFrom} names the cycle it was made from on the
 * first start after the update (shown once as a banner), null otherwise.
 */
public record Board(String id, String project, String name, boolean isDefault, BoardState state, String migratedFrom,
                    Instant createdAt, Instant updatedAt, Actor updatedBy) {

    public static final int MAX_NAME = 120;

    public Board {
        project = project == null ? "" : project;
        name = name == null || name.isBlank() ? project : name.strip();
        state = state == null || isDefault ? BoardState.OPEN : state;
    }

    public boolean open() {
        return state == BoardState.OPEN;
    }

    public Board renamed(String newName, Instant at, Actor by) {
        return new Board(id, project, newName, isDefault, state, migratedFrom, createdAt, at, by);
    }

    public Board withState(BoardState newState, Instant at, Actor by) {
        return new Board(id, project, name, isDefault, newState, migratedFrom, createdAt, at, by);
    }
}
