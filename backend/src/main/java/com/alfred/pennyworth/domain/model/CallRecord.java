package com.alfred.pennyworth.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Mirrors the JSON shape written by the proxy addon (proxy/log_and_route.py) and served by GET /calls.
 * Reused directly as both the file-parsing target and the HTTP response body - the wire shape and the
 * domain shape are identical here, so a separate mapping DTO would just duplicate this record for no
 * behavioral gain (see the DTO-vs-domain-reuse rule in CLAUDE.md).
 */
public record CallRecord(
        @JsonProperty("original_url") String originalUrl,
        String url,
        String method,
        RequestData request,
        String timestamp,
        @JsonProperty("duration_ms") Double durationMs,
        ta response,
        String error
) {
}
