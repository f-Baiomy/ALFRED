package com.fathy.alfred.backend.sessioncycles.domain.model;

/** Input to CreateSessionCycleUseCase - already-validated fields for a cycle that doesn't have an id, createdAt, or status yet (the application service assigns those). */
public record NewSessionCycle(
        String name,
        String assignedTo
) {
}
