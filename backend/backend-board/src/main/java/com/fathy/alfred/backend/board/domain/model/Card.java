package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.EnumSet;
import java.util.Set;

/**
 * One bug, task, note or question on a project's board (specs/014-task-board data-model.md). {@code number} is unique
 * per project and never reused; {@code resolution} is set exactly when {@code status} is CLOSED. {@code signature}
 * ({@code <signal>|<METHOD> <endpoint pattern>}, from the first call the card mentions) drives the "looks like a closed
 * card" hint and the refusal of a Claude card that repeats one the user dismissed.
 */
public record Card(
        String id,
        String project,
        int number,
        CardKind kind,
        String title,
        String description,
        CardStatus status,
        Resolution resolution,
        String reason,
        Set<Flag> flags,
        Scope scope,
        Actor author,
        String cycleId,
        boolean cycleDeleted,
        String signature,
        Instant createdAt,
        Instant updatedAt,
        Actor updatedBy) {

    public Card {
        project = project == null ? "" : project;
        description = description == null ? "" : description;
        flags = flags == null || flags.isEmpty() ? Set.of() : Set.copyOf(EnumSet.copyOf(flags));
        scope = scope == null ? Scope.NOT_DECIDED : scope;
    }

    public boolean open() {
        return status != CardStatus.CLOSED;
    }

    public Card withStatus(CardStatus newStatus, Resolution newResolution, String newReason, Scope newScope, Instant at, Actor by) {
        return new Card(id, project, number, kind, title, description, newStatus, newResolution, newReason, flags, newScope, author,
                cycleId, cycleDeleted, signature, createdAt, at, by);
    }

    public Card withFields(String newTitle, String newDescription, CardKind newKind, Set<Flag> newFlags, Scope newScope,
                           String newCycleId, String newProject, Instant at, Actor by) {
        return new Card(id, newProject, number, newKind, newTitle, newDescription, status, resolution, reason, newFlags, newScope,
                author, newCycleId, cycleDeleted, signature, createdAt, at, by);
    }

    public Card withReason(String newReason, Instant at, Actor by) {
        return new Card(id, project, number, kind, title, description, status, resolution, newReason, flags, scope, author, cycleId,
                cycleDeleted, signature, createdAt, at, by);
    }

    /** The same card, changed now by {@code by} - a comment or a link counts as a change for "stale". */
    public Card touched(Instant at, Actor by) {
        return new Card(id, project, number, kind, title, description, status, resolution, reason, flags, scope, author, cycleId,
                cycleDeleted, signature, createdAt, at, by);
    }

    public Card withSignature(String newSignature) {
        return new Card(id, project, number, kind, title, description, status, resolution, reason, flags, scope, author, cycleId,
                cycleDeleted, newSignature, createdAt, updatedAt, updatedBy);
    }

    public Card withNumber(int newNumber) {
        return new Card(id, project, newNumber, kind, title, description, status, resolution, reason, flags, scope, author, cycleId,
                cycleDeleted, signature, createdAt, updatedAt, updatedBy);
    }

    public Card withDescription(String newDescription) {
        return new Card(id, project, number, kind, title, newDescription, status, resolution, reason, flags, scope, author, cycleId,
                cycleDeleted, signature, createdAt, updatedAt, updatedBy);
    }
}
