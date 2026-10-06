package com.fathy.alfred.backend.sessioncycles.application.port.out;

import java.util.List;

/**
 * Told about calls copied into a cycle that it did not hold before - an import, or calls added from anywhere
 * (specs/010-mcp-log-investigation, FR-018): whoever indexes calls (triage, through backend-app) learns of them as it
 * learns of recorded ones. This slice knows nothing of who listens.
 */
public interface CopiedCallsObserverPort {

    default void inboundCopied(String cycleId, List<com.fathy.alfred.backend.internalcalls.domain.model.CallRecord> calls) {
    }

    default void outboundCopied(String cycleId, List<com.fathy.alfred.backend.calls.domain.model.CallRecord> calls) {
    }
}
