package com.fathy.alfred.backend.triage.domain.model;

/**
 * A call as one of the call slices reported it, translated by backend-app/triagebridge - this slice never sees either
 * slice's own CallRecord. {@code responseBody} is read once, to find an error inside a 2xx body or an empty result,
 * and never stored here.
 *
 * @param project      inbound: the project (reverse-proxy service) it came in through; outbound: null
 * @param parentCallId outbound: the inbound call that made it, when the db-agent linked them; else null
 * @param startedAt    ISO-8601 instant, as the call slices store it
 * @param state        IN_PROGRESS / COMPLETED / ERROR
 */
public record ObservedCall(String callId, CallDirection direction, String project, String parentCallId, String method, String url,
                           Integer status, String error, String startedAt, Double durationMs, String state, String responseBody) {
}
