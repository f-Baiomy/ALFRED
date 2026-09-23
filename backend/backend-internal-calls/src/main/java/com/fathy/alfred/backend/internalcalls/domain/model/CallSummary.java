package com.fathy.alfred.backend.internalcalls.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The list-view shape of a call - everything CallRecord has except request/response headers and
 * bodies. GET /internal-calls returns this instead of CallRecord; the full headers/body are
 * fetched only on demand via GET /internal-calls/{id}/detail once a call is actually expanded.
 * {@code status} is flattened out of CallRecord.response() since that's the only part of the
 * response a list view needs. {@code supplierName} is a best-effort extraction (see
 * {@link #supplierNameOf}) computed here rather than left to the detail endpoint. {@code
 * serviceName} is carried straight through from CallRecord - see its doc for what it means.
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
        String supplierName,
        CallLifecycleStatus state,
        @JsonProperty("session_id") String sessionId,
        @JsonProperty("operation_id") String operationId,
        @JsonProperty("service_name") String serviceName,
        /** Carried into the list so a collapsed card can show its intercepted badge without a detail fetch - as backend-calls' summary does. */
        @JsonInclude(JsonInclude.Include.NON_NULL) CallInterception interception,
        @JsonProperty("resend_of") String resendOf,
        @JsonProperty("resend_edits") String resendEdits
) {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    /** Pre-resend shape. */
    public CallSummary(String id, String originalUrl, String url, String method, String timestamp,
                        Double durationMs, Integer status, String error, String supplierName, CallLifecycleStatus state,
                        String sessionId, String operationId, String serviceName, CallInterception interception) {
        this(id, originalUrl, url, method, timestamp, durationMs, status, error, supplierName, state, sessionId,
                operationId, serviceName, interception, null, null);
    }

    /** Pre-interception shape - every call site built before that field existed gets null. */
    public CallSummary(String id, String originalUrl, String url, String method, String timestamp,
                        Double durationMs, Integer status, String error, String supplierName, CallLifecycleStatus state,
                        String sessionId, String operationId, String serviceName) {
        this(id, originalUrl, url, method, timestamp, durationMs, status, error, supplierName, state, sessionId,
                operationId, serviceName, null, null, null);
    }

    /** Pre-service-name shape - every call site built before that field existed gets null (treated as "unknown" by every reader). */
    public CallSummary(String id, String originalUrl, String url, String method, String timestamp,
                        Double durationMs, Integer status, String error, String supplierName, CallLifecycleStatus state,
                        String sessionId, String operationId) {
        this(id, originalUrl, url, method, timestamp, durationMs, status, error, supplierName, state, sessionId, operationId, null, null, null, null);
    }

    /** Pre-session/operation-id shape - every call site built before those fields existed gets null for both (and for serviceName). */
    public CallSummary(String id, String originalUrl, String url, String method, String timestamp,
                        Double durationMs, Integer status, String error, String supplierName, CallLifecycleStatus state) {
        this(id, originalUrl, url, method, timestamp, durationMs, status, error, supplierName, state, null, null, null, null, null, null);
    }

    /** Pre-two-phase shape, kept for the same reason CallRecord keeps its own 9-arg constructor - every existing call site already only ever built an already-resolved summary, so state is derived from error here instead of requiring every caller to pass it explicitly. */
    public CallSummary(String id, String originalUrl, String url, String method, String timestamp,
                        Double durationMs, Integer status, String error, String supplierName) {
        this(id, originalUrl, url, method, timestamp, durationMs, status, error, supplierName,
                (error != null && !error.isBlank()) ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED, null, null, null, null, null, null);
    }

    public static CallSummary of(CallRecord call) {
        Integer status = call.response() != null ? call.response().status() : null;
        CallRecord normalized = CallRecord.withDerivedStateIfMissing(call);
        return new CallSummary(call.id(), call.originalUrl(), call.url(), call.method(), call.timestamp(), call.durationMs(), status, call.error(), supplierNameOf(call), normalized.state(), call.sessionId(), call.operationId(), call.serviceName(), call.interception(), call.resendOf(), call.resendEdits());
    }

    /**
     * Best-effort supplier name parsed from the call's request body's "supplier" JSON field. Null
     * when there's no request, the body isn't JSON, or it has no such field - callers treat that
     * as "unknown", not an error.
     */
    public static String supplierNameOf(CallRecord call) {
        RequestData request = call.request();
        return request == null ? null : supplierNameOfBody(request.body());
    }

    /**
     * Same extraction as {@link #supplierNameOf}, taking just the request body string - lets an
     * adapter precompute and store this at write time instead of fetching the full request body
     * just to derive it again on every read.
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
