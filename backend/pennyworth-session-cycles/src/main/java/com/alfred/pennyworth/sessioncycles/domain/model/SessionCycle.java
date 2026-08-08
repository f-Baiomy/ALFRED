package com.alfred.pennyworth.sessioncycles.domain.model;

/** A named, recordable/pausable group of calls. assignedTo is a free-form profile id reserved for a future profiles feature - not validated against anything today. */
public record SessionCycle(
        String id,
        String name,
        String createdAt,
        String assignedTo,
        SessionCycleStatus status
) {
}
