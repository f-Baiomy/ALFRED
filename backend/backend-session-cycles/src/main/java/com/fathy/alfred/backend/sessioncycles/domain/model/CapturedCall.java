package com.fathy.alfred.backend.sessioncycles.domain.model;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

/** One call captured into a session-cycle while it was recording. Has its own id (distinct from the underlying CallRecord, which has none) so a single captured call can be addressed for removal. */
public record CapturedCall(
        String id,
        String capturedAt,
        CallRecord call
) {
}
