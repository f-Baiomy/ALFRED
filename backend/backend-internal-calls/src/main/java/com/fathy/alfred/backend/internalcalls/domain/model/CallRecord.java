package com.fathy.alfred.backend.internalcalls.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

/**
 * Mirrors the JSON shape written by the reverse proxy addon (proxy/log_and_route_reverse.py) and
 * served by GET /internal-calls. Reused directly as both the file-parsing target and the HTTP
 * response body - the wire shape and the domain shape are identical here, so a separate mapping
 * DTO would just duplicate this record for no behavioral gain (see the DTO-vs-domain-reuse rule
 * in CLAUDE.md). Field-for-field identical to backend-calls' own CallRecord (same JSON property
 * names) purely so the existing Angular frontend's CallRecord/CallSummary TypeScript models and
 * export/download logic work against this slice unmodified - the two are otherwise fully
 * independent slices with no shared code or dependency. {@code serviceName} is the one field
 * backend-calls' CallRecord doesn't have, since only inbound calls have a named project to
 * attribute to.
 *
 * <p>{@code id} is assigned by the backend, never sent by the proxy - the webhook payload has no
 * "id" property in the malformed/legacy case, so Jackson deserializes it as null, and
 * InternalCallsService.receivePreparedCall assigns a fresh UUID before saving whenever it sees a
 * blank id.
 *
 * <p>{@code state} tracks the two-phase logging lifecycle (see {@link CallLifecycleStatus}) -
 * separate from the HTTP status code inside {@link #response()}. The proxy logs a call twice:
 * once at request time via {@code POST /internal-calls/webhook/prepare} (state
 * {@code IN_PROGRESS}, no response yet), then again via
 * {@code POST /internal-calls/webhook/{id}/complete} once the upstream responds or fails.
 *
 * <p>{@code serviceName} is the project name the addon resolved this flow to (see
 * proxy/log_and_route_reverse.py's PORT_MAP), or its reserved "unknown" bucket for an
 * unrecognized arrival port - never null for anything logged after this field was added. A call
 * logged before it existed has {@code serviceName == null}, which every read path treats the same
 * as "unknown" (see LoggingToggleService.UNKNOWN_NAME) rather than a distinct bucket - there's
 * nothing to gain from telling old, unattributed data apart from genuinely-unmatched new traffic.
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
        String error,
        CallLifecycleStatus state,
        @JsonProperty("session_id") String sessionId,
        @JsonProperty("operation_id") String operationId,
        @JsonProperty("service_name") String serviceName,
        /**
         * What an interception rule did to this call, or null when none touched it. Written only
         * when present, so a line for an untouched call is byte-for-byte what it was before.
         */
        @JsonInclude(JsonInclude.Include.NON_NULL) CallInterception interception,
        /** The call this one resends, or null. Set from the proxy's X-Alfred-Resend-Of header. */
        @JsonProperty("resend_of") @JsonInclude(JsonInclude.Include.NON_NULL) String resendOf,
        /** What the resend changed, as JSON text - header NAMES only (data-model §7). */
        @JsonProperty("resend_edits") @JsonInclude(JsonInclude.Include.NON_NULL) @JsonRawValue @JsonDeserialize(using = RawJsonDeserializer.class) String resendEdits
) {
    /** Pre-resend shape. */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state,
                       String sessionId, String operationId, String serviceName, CallInterception interception) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, sessionId,
                operationId, serviceName, interception, null, null);
    }

    /** Pre-interception shape - every call site built before that field existed gets null. */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state,
                       String sessionId, String operationId, String serviceName) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, sessionId,
                operationId, serviceName, null, null, null);
    }

    /** The same call carrying the interception record the completion webhook brought. */
    public CallRecord withInterception(CallInterception value) {
        return new CallRecord(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state,
                sessionId, operationId, serviceName, value == null || value.isEmpty() ? null : value, resendOf, resendEdits);
    }

    public CallRecord withResend(String of, String edits) {
        return new CallRecord(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state,
                sessionId, operationId, serviceName, interception, of, edits);
    }

    /** Pre-service-name shape - kept so a call site built before that field existed doesn't need to touch a new required argument. serviceName is null (treated as "unknown" by every reader). */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state,
                       String sessionId, String operationId) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, sessionId, operationId, null, null, null, null);
    }

    /** Pre-session/operation-id shape - kept so a call site built before those fields existed doesn't need to touch a new required argument. sessionId/operationId/serviceName are all null. */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, null, null, null, null, null, null);
    }

    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error,
                (error != null && !error.isBlank()) ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED, null, null, null, null, null, null);
    }

    /**
     * Jackson (via the records/parameter-names module) deserializes JSON through the canonical
     * (13-arg) constructor, bypassing the derivation the shorter constructors above provide - so
     * any JSON that predates the {@code state} field comes back with {@code state == null}. Call
     * sites that read a CallRecord fresh off the wire/disk rather than constructing one themselves
     * should run it through this to normalize that, the same way {@code withGeneratedId}
     * normalizes a missing id. Does not touch sessionId/operationId/serviceName - null is a valid,
     * meaningful value there.
     */
    public static CallRecord withDerivedStateIfMissing(CallRecord call) {
        if (call.state() != null) {
            return call;
        }
        boolean hasError = call.error() != null && !call.error().isBlank();
        CallLifecycleStatus derived = hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED;
        return new CallRecord(call.id(), call.originalUrl(), call.url(), call.method(), call.request(),
                call.timestamp(), call.durationMs(), call.response(), call.error(), derived, call.sessionId(), call.operationId(), call.serviceName(),
                call.interception(), call.resendOf(), call.resendEdits());
    }
}
