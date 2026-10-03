package com.fathy.alfred.backend.sessioncycles.domain.model;

/**
 * A named, recordable/pausable group of calls. assignedTo is a free-form profile id reserved for a future profiles feature - not validated against anything today.
 *
 * <p>{@code reliveRunId} is set on a Relive run's own cycle: it holds every call that run made and
 * nothing else (capture routes a run's calls only there), it is never listed with the session
 * cycles, never records (always PAUSED), and it is deleted with its run. {@code reliveCycleId} is
 * the Relive cycle the run belongs to, for the way back. Both are null on an ordinary cycle.
 */
public record SessionCycle(
        String id,
        String name,
        String createdAt,
        String assignedTo,
        SessionCycleStatus status,
        String reliveRunId,
        String reliveCycleId
) {
    public SessionCycle(String id, String name, String createdAt, String assignedTo, SessionCycleStatus status) {
        this(id, name, createdAt, assignedTo, status, null, null);
    }
}
