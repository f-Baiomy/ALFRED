package com.fathy.alfred.backend.sessioncycles.domain.model;

import com.fathy.alfred.backend.calls.domain.model.CallSummary;

/** The list-view shape of a captured call - see CallSummary for why request/response headers/bodies are omitted. */
public record CapturedCallSummary(String id, String capturedAt, CallSummary call) {

    public static CapturedCallSummary of(CapturedCall captured) {
        return new CapturedCallSummary(captured.id(), captured.capturedAt(), CallSummary.of(captured.call()));
    }
}
