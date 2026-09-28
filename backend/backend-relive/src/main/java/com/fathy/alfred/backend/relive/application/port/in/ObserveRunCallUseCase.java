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
     */
    record ObservedCall(String callId, String serviceName, JsonNode relive, boolean reachedUpstream,
                         JsonNode request, JsonNode response, Integer status, Long durationMs, String at) {
    }
}
