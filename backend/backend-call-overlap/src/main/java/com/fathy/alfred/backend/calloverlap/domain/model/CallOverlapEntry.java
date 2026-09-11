package com.fathy.alfred.backend.calloverlap.domain.model;

/**
 * The minimal shape GET /call-overlaps returns for one call, merged from either backend-calls
 * (external/supplier traffic) or backend-internal-calls (frontend->WildFly traffic) - just enough
 * for the frontend's own containment/nesting check ({@code [timestamp, timestamp + durationMs]})
 * to run against, nothing request/response-shaped. {@code source} distinguishes which slice a call
 * came from ("external" | "internal"); {@code serviceName} is the owning project name, carried
 * through from either slice's own CallRecord.serviceName field (both external and internal calls
 * can have one now - null still just means "unknown"/not resolved, not a distinct bucket).
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
