package com.fathy.alfred.backend.sessioncycles.domain.model;

/**
 * A named, recordable/pausable group of calls. assignedTo is a free-form profile id reserved for a future profiles feature - not validated against anything today.
 *
 * <p>{@code reliveRunId} is set on a Relive run's own cycle: it holds every call that run made and
 * nothing else (capture routes a run's calls only there), it is never listed with the session
 * cycles, never records (always PAUSED), and it is deleted with its run. {@code reliveCycleId} is
 * the Relive cycle the run belongs to, for the way back. Both are null on an ordinary cycle.
 *
 * <p>{@code description} is the user's text about the cycle - what it is for, its steps ({@code - [ ] step}), what is
 * expected (specs/033). {@code summary} is Claude's own note, written when a recording pauses - never mixed into the
 * description. Both are null when not written.
 */
public record SessionCycle(
        String id,
        String name,
        String createdAt,
        String assignedTo,
        SessionCycleStatus status,
        String reliveRunId,
        String reliveCycleId,
        String description,
        String summary
) {
    public SessionCycle(String id, String name, String createdAt, String assignedTo, SessionCycleStatus status,
                        String reliveRunId, String reliveCycleId) {
        this(id, name, createdAt, assignedTo, status, reliveRunId, reliveCycleId, null, null);
    }

    public SessionCycle(String id, String name, String createdAt, String assignedTo, SessionCycleStatus status) {
        this(id, name, createdAt, assignedTo, status, null, null, null, null);
    }

    public SessionCycle withName(String next) {
        return new SessionCycle(id, next, createdAt, assignedTo, status, reliveRunId, reliveCycleId, description, summary);
    }

    public SessionCycle withStatus(SessionCycleStatus next) {
        return new SessionCycle(id, name, createdAt, assignedTo, next, reliveRunId, reliveCycleId, description, summary);
    }

    public SessionCycle withAssignedTo(String next) {
        return new SessionCycle(id, name, createdAt, next, status, reliveRunId, reliveCycleId, description, summary);
    }

    public SessionCycle withReliveCycleId(String next) {
        return new SessionCycle(id, name, createdAt, assignedTo, status, reliveRunId, next, description, summary);
    }

    /** The notes as given: null leaves one as it is, "" clears it. */
    public SessionCycle withNotes(String nextDescription, String nextSummary) {
        return new SessionCycle(id, name, createdAt, assignedTo, status, reliveRunId, reliveCycleId,
                nextDescription == null ? description : blankToNull(nextDescription),
                nextSummary == null ? summary : blankToNull(nextSummary));
    }

    private static String blankToNull(String s) {
        return s.isBlank() ? null : s;
    }
}
