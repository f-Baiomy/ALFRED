package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Mirrors the JSON shape written by the proxy addon (proxy/log_and_route.py) and served by GET /calls.
 * Reused directly as both the file-parsing target and the HTTP response body - the wire shape and the
 * domain shape are identical here, so a separate mapping DTO would just duplicate this record for no
 * behavioral gain (see the DTO-vs-domain-reuse rule in CLAUDE.md).
 *
 * <p>{@code id} is assigned by the backend, never sent by the proxy - the webhook payload has no
 * "id" property, so Jackson deserializes it as null, and CallsService.receiveNewCall assigns a
 * fresh UUID before saving whenever it sees a null id. A line written before this field existed
 * also deserializes with a null id - FileCallLogAdapter/JsonFileCapturedCallsStoreAdapter backfill
 * and persist a real id for those the first time the file is read, so it's stable from then on.
 */
public record CallRecord(
        String id,
        @JsonProperty("original_url") String originalUrl,
        String url,
        String method,
        RequestData request,
        String timestamp,
        @JsonProperty("duration_ms") Double durationMs,
        ResponseData response,
        String error
) {
}
