package com.alfred.pennyworth;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Mirrors the JSON shape written by the proxy addon and served by GET /calls. */
public record CallRecordDto(
        @JsonProperty("original_url") String originalUrl,
        String url,
        String method,
        RequestDataDto request,
        String timestamp,
        @JsonProperty("duration_ms") Double durationMs,
        ResponseDataDto response,
        String error
) {
}
