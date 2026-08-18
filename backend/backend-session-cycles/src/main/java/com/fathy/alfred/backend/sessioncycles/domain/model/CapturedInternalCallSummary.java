package com.fathy.alfred.backend.sessioncycles.domain.model;

/** The list-view shape of a captured internal call - mirrors CapturedCallSummary, typed to backend-internal-calls' own CallSummary. */
public record CapturedInternalCallSummary(String id, String capturedAt, com.fathy.alfred.backend.internalcalls.domain.model.CallSummary call) {

    public static CapturedInternalCallSummary of(CapturedInternalCall captured) {
        return new CapturedInternalCallSummary(captured.id(), captured.capturedAt(), com.fathy.alfred.backend.internalcalls.domain.model.CallSummary.of(captured.call()));
    }
}
