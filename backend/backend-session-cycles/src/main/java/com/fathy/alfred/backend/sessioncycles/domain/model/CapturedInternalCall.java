package com.fathy.alfred.backend.sessioncycles.domain.model;

/**
 * One internal call (frontend->WildFly traffic, via backend-internal-calls) captured into a
 * session-cycle while it was recording. Mirrors CapturedCall exactly, typed to
 * backend-internal-calls' own CallRecord instead of backend-calls' - a deliberately parallel,
 * symmetric pipeline rather than a generalized one (see the session-cycles internal-calls design
 * doc/plan). Has its own id (distinct from the underlying CallRecord) so a single captured call
 * can be addressed for removal.
 */
public record CapturedInternalCall(
        String id,
        String capturedAt,
        com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call
) {
}
