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
        @JsonProperty("operation_id") String operationId
) {
    /**
     * Pre-session/operation-id shape (the two-phase-logging-era canonical constructor) - kept so
     * every call site built before those fields existed doesn't need to touch a new required
     * argument. {@code sessionId}/{@code operationId} are both null; see
     * {@link com.fathy.alfred.backend.calls.application.service.CallsService#receivePreparedCall}
     * for where a blank one is filled in with a generated UUID instead.
     */
    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error, CallLifecycleStatus state) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error, state, null, null);
    }

    public CallRecord(String id, String originalUrl, String url, String method, RequestData request,
                       String timestamp, Double durationMs, ResponseData response, String error) {
        this(id, originalUrl, url, method, request, timestamp, durationMs, response, error,
                (error != null && !error.isBlank()) ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED, null, null);
    }

    /**
     * Jackson (via the records/parameter-names module) deserializes JSON through the canonical
     * (12-arg) constructor, bypassing the derivation the shorter constructors above provide - so
     * any JSON that predates the {@code state} field (an old RECENT_CALLS.log line, or -
     * defensively - any other legacy source) comes back with {@code state == null}. Call sites
     * that read a CallRecord fresh off the wire/disk rather than constructing one themselves
     * should run it through this to normalize that, the same way {@code withGeneratedId}
     * normalizes a missing id. Does not touch sessionId/operationId - null is a valid, meaningful
     * value there (a call logged before those fields existed simply has none), unlike state.
     */
    public static CallRecord withDerivedStateIfMissing(CallRecord call) {
        if (call.state() != null) {
            return call;
        }
        boolean hasError = call.error() != null && !call.error().isBlank();
        CallLifecycleStatus derived = hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED;
        return new CallRecord(call.id(), call.originalUrl(), call.url(), call.method(), call.request(),
                call.timestamp(), call.durationMs(), call.response(), call.error(), derived, call.sessionId(), call.operationId());
    }
}
