package com.alfred.pennyworth.sessioncycles.domain.model;

/**
 * Input to UpdateSessionCycleUseCase. For {@code name}, a null field means "leave this alone",
 * not "clear it" - the same convention used by similar update records elsewhere in this codebase.
 * {@code assignedTo} is the deliberate exception: it's always applied exactly as given, since
 * every caller (the edit dialog, bulk reassign) always sends the value it wants - including null
 * to explicitly clear it back to unassigned - so there's no "leave assignedTo unchanged" case to
 * preserve.
 */
public record SessionCycleUpdate(
        String name,
        String assignedTo
) {
}
