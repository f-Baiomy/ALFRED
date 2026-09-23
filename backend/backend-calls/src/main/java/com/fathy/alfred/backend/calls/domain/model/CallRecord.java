package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonRawValue;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

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
 *
 * <p>{@code state} tracks the two-phase logging lifecycle (see {@link CallLifecycleStatus}) -
 * separate from the HTTP status code inside {@link #response()}. The proxy now logs a call twice:
 * once at request time via {@code POST /calls/webhook/prepare} (state {@code IN_PROGRESS}, no
 * response yet), then again via {@code POST /calls/webhook/{id}/complete} once the upstream
 * responds or fails. The 9-arg constructor below is the pre-two-phase shape, kept so every
 * existing call site (which always constructed an already-resolved call) doesn't need to touch a
 * new required argument - it derives {@code state} from whether {@code error} is set, exactly the
 * rule every one of those call sites already implicitly followed. New prepare-phase code that
 * needs {@code IN_PROGRESS} explicitly uses the full canonical constructor instead.
 *
 * <p>{@code serviceName} is the internal project name the forward-proxy addon resolved an
 * outbound call's arrival port to (or its "unknown" bucket), mirroring backend-internal-calls'
 * own CallRecord.serviceName field/convention exactly (same {@code @JsonProperty("service_name")}
 * wire name) - added later than every other field here, so it's the new last canonical
 * constructor param with a backward-compatible shorter overload defaulting it to null. Null means
 * either "logged before this field existed" or "the proxy couldn't resolve an owning project for
 * this call" - every read path treats both the same as "unknown", not a distinct bucket.
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
        CallTiming timing,
        CallInterception interception,
        /** The call this one resends, or null. Set from the proxy's X-Alfred-Resend-Of header. */
        @JsonProperty("resend_of") @JsonInclude(JsonInclude.Include.NON_NULL) String resendOf,
        /** What the resend changed, as JSON text - header NAMES only (data-model §7). */
        @JsonProperty("resend_edits") @JsonInclude(JsonInclude.Include.NON_NULL) @JsonRawValue @JsonDeserialize(using = RawJsonDeserializer.class) String resendEdits
) {
    /**
     * Pre-interception shape - the newest field, added the same backward-compatible way as timing
     * and serviceName before it. Null means no interception rule touched this call, which is the
     * overwhelmingly common case and the reason the field is nullable rather than an empty object.
     */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state,
                       String sessionId, String operationId, String serviceName, CallTiming timing) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, sessionId, operationId, serviceName, timing, null, null, null);
    }

    /** Pre-timing shape - the newest field, added the same backward-compatible way as serviceName before it. Null means "not measured" (a call logged before the proxy reported phase timings), never zero. */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state,
                       String sessionId, String operationId, String serviceName) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, sessionId, operationId, serviceName, null, null, null, null);
    }

    /** Pre-service-name shape - kept so a call site built before that field existed doesn't need to touch a new required argument. serviceName is null (treated as "unknown" by every reader). */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state,
                       String sessionId, String operationId) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, sessionId, operationId, null, null, null, null, null);
    }

    /**
     * Pre-session/operation-id shape (the two-phase-logging-era canonical constructor) - kept so
     * every call site built before those fields existed doesn't need to touch a new required
     * argument. {@code sessionId}/{@code operationId}/{@code serviceName} are all null; see
     * {@link com.fathy.alfred.backend.calls.application.service.CallsService#receivePreparedCall}
     * for where a blank one is filled in with a generated UUID instead.
     */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, null, null, null, null, null, null, null);
    }

    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error,
                (error != null && !error.isBlank()) ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED, null, null, null, null, null, null, null);
    }

    /**
     * Jackson (via the records/parameter-names module) deserializes JSON through the canonical
     * (13-arg) constructor, bypassing the derivation the shorter constructors above provide - so
     * any JSON that predates the {@code state} field (an old RECENT_CALLS.log line, or -
     * defensively - any other legacy source) comes back with {@code state == null}. Call sites
     * that read a CallRecord fresh off the wire/disk rather than constructing one themselves
     * should run it through this to normalize that, the same way {@code withGeneratedId}
     * normalizes a missing id. Does not touch sessionId/operationId/serviceName - null is a valid,
     * meaningful value there (a call logged before those fields existed simply has none), unlike
     * state.
     */
    public static CallRecord withDerivedStateIfMissing(CallRecord call) {
        if (call.state() != null) {
            return call;
        }
        boolean hasError = call.error() != null && !call.error().isBlank();
        CallLifecycleStatus derived = hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED;
        return new CallRecord(call.id(), call.originalUrl(), call.url(), call.method(), call.request(),
                call.timestamp(), call.durationMs(), call.response(), call.error(), derived, call.sessionId(), call.operationId(), call.serviceName(), call.timing(), call.interception(), call.resendOf(), call.resendEdits());
    }

    public CallRecord withResend(String of, String edits) {
        return new CallRecord(this.id(), this.originalUrl(), this.url(), this.method(), this.request(),
                this.timestamp(), this.durationMs(), this.response(), this.error(), this.state(), this.sessionId(), this.operationId(), this.serviceName(), this.timing(), this.interception(), of, edits);
    }
}
