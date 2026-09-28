package com.fathy.alfred.backend.relive.application.port.in;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Inbound port: the webhook pipeline forwards every prepared/completed call here, through
 * backend-app's {@code ReliveCallObserverAdapter} (T050), which implements backend-calls'
 * {@code NewCallObserverPort} (outbound, two-phase) and backend-internal-calls'
 * {@code NewInternalCallObserverPort} (inbound, completion-only) and translates either slice's own
 * {@code CallRecord} into {@link ObservedCall} - backend-relive must not depend on either calls
 * slice directly (ArchUnit).
 */
public interface ObserveRunCallUseCase {

    /** An outbound call was just intercepted (state IN_PROGRESS) - maintains {@code relive/inflight.json}. */
    void onOutboundCallPrepared(ObservedCall call);

    /** An outbound call settled - removes it from {@code inflight.json}, draining a STOPPING run if it was the last one. */
    void onOutboundCallCompleted(ObservedCall call);

    /** An inbound call settled (backend-internal-calls has no two-phase capture concept). */
    void onInboundCallCompleted(ObservedCall call);

    /**
     * @param relive opaque JSON the proxy attached to the call: {@code {runId, stepKey,
     *               attribution, choice, ruleIds[]}} when attributed to one run, or
     *               {@code {ambiguousRunIds:[...]}} (FR-050a) when it matched more than one and was
     *               blocked; null when the call carries no relive attribution at all.
     * @param request/response opaque, used only to populate a LiveCall row (FR-015b) when {@code reachedUpstream}.
     * @param method/url carried through to the {@code run-call} WS event (T077) - the Guided
     *                   driver has no {@code stepKey} to go on for an inbound call until the
     *                   frontend matches it by endpoint, and this is the only place that endpoint
     *                   is available without a new "get one call by id" read endpoint.
     */
    record ObservedCall(String callId, String serviceName, JsonNode relive, boolean reachedUpstream,
                         JsonNode request, JsonNode response, Integer status, Long durationMs, String at,
                         String method, String url) {

        /** Pre-T077 shape, kept so every existing call site (which never had an endpoint to give) doesn't need to touch a new required argument. */
        public ObservedCall(String callId, String serviceName, JsonNode relive, boolean reachedUpstream,
                             JsonNode request, JsonNode response, Integer status, Long durationMs, String at) {
            this(callId, serviceName, relive, reachedUpstream, request, response, status, durationMs, at, null, null);
        }
    }
}
