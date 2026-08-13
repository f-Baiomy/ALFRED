package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The list-view shape of a call - everything CallRecord has except request/response headers and
 * bodies, which routinely dominate a call's size (measured: ~38KB average, some far larger) and
 * are rarely needed for every call in a list someone is scanning, only the handful they actually
 * open. GET /calls and GET /session-cycles/{id}/calls return this instead of CallRecord; the full
 * headers/body are fetched only on demand via GET /calls/{id}/detail (or the session-cycles
 * equivalent) once a call is actually expanded. {@code status} is flattened out of
 * CallRecord.response() since that's the only part of the response a list view needs.
 * {@code supplierName} is a best-effort extraction (see {@link #supplierNameOf}) computed here
 * rather than left to the detail endpoint, so the list can show it without waiting for a call to
 * be expanded.
 */
public record CallSummary(
        String id,
        @JsonProperty("original_url") String originalUrl,
        String url,
        String method,
        String timestamp,
        @JsonProperty("duration_ms") Double durationMs,
        Integer status,
        String error,
        String supplierName
) {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    public static CallSummary of(CallRecord call) {
        Integer status = call.response() != null ? call.response().status() : null;
        return new CallSummary(call.id(), call.originalUrl(), call.url(), call.method(), call.timestamp(), call.durationMs(), status, call.error(), supplierNameOf(call));
    }

    /**
     * Best-effort supplier name parsed from the call's request body's "supplier" JSON field - the
     * same field ExportMetadataService (backend-export) extracts for the export form's pre-fill.
     * Null when there's no request, the body isn't JSON, or it has no such field - callers treat
     * that as "unknown", not an error.
     */
    public static String supplierNameOf(CallRecord call) {
        RequestData request = call.request();
        return request == null ? null : supplierNameOfBody(request.body());
    }

    /**
     * Same extraction as {@link #supplierNameOf}, taking just the request body string - lets a
     * SQL-backed adapter precompute and store this at write time (in a dedicated column) so list
     * queries can read it back directly instead of fetching the full request body just to derive
     * it again on every read.
     */
    public static String supplierNameOfBody(String requestBody) {
        if (requestBody == null || requestBody.isBlank()) {
            return null;
        }
        try {
            JsonNode node = OBJECT_MAPPER.readTree(requestBody);
            JsonNode value = node.get("supplier");
            return (value == null || value.isNull()) ? null : value.asText();
        } catch (Exception e) {
            return null;
        }
    }
}
