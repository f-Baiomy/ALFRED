package com.fathy.alfred.backend.sessioncycles.domain.model;

/** A Relive run's own cycle, and whether this request created it (and filled it from the call logs). */
public record ReliveRunCycle(SessionCycle cycle, boolean created) {
}
