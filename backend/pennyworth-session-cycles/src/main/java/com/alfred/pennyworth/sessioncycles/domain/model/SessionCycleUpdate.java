package com.alfred.pennyworth.sessioncycles.domain.model;

/** Input to UpdateSessionCycleUseCase - a null field means "leave this alone", not "clear it". */
public record SessionCycleUpdate(
        String name,
        String assignedTo
) {
}
