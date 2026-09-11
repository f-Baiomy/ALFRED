package com.fathy.alfred.backend.sessioncycles.domain.model;

/**
 * The minimal shape GET /session-cycles/{id}/call-overlaps returns for one captured call, merged
 * from either this cycle's own captured-calls store (external/supplier traffic) or its
 * captured-internal-calls store (frontend->WildFly traffic) - just enough for the frontend's own
 * containment/nesting check ({@code [timestamp, timestamp + durationMs]}) to run against, nothing
 * request/response-shaped. Deliberately its own type rather than a shared one with
 * backend-call-overlap's identically-shaped record: session-cycles must stay isolated from that
 * module (it isn't one of session-cycles' two allowed cross-slice dependencies), the same reason
 * this slice keeps its own copy of CallListSupport instead of sharing backend-calls'.
 * {@code source} distinguishes which store a call came from ("external" | "internal");
 * {@code serviceName} is the owning project name, carried through from either slice's own
 * CallRecord.serviceName field (both external and internal calls can have one now - null still
 * just means "unknown"/not resolved, not a distinct bucket).
 */
public record CallOverlapEntry(
        String id,
        String source,
        String serviceName,
        String timestamp,
        Double durationMs,
        Integer status,
        String error
) {
    public static final String SOURCE_EXTERNAL = "external";
    public static final String SOURCE_INTERNAL = "internal";
}
