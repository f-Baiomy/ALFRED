package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The list-view shape of a call - everything CallRecord has except request/response headers and
 * bodies, which routinely dominate a call's size (measured: ~38KB average, some far larger) and
 * are rarely needed for every call in a list someone is scanning, only the handful they actually
 * open. GET /calls and GET /session-cycles/{id}/calls return this instead of CallRecord; the full
 * headers/body are fetched only on demand via GET /calls/{id}/detail (or the session-cycles
 * equivalent) once a call is actually expanded. {@code status} is flattened out of
 * CallRecord.response() since that's the only part of the response a list view needs.
 */
public record CallSummary(
        String id,
        @JsonProperty("original_url") String originalUrl,
        String url,
        String method,
        String timestamp,
        @JsonProperty("duration_ms") Double durationMs,
        Integer status,
        String error
) {
    public static CallSummary of(CallRecord call) {
        Integer status = call.response() != null ? call.response().status() : null;
        return new CallSummary(call.id(), call.originalUrl(), call.url(), call.method(), call.timestamp(), call.durationMs(), status, call.error());
    }
}
