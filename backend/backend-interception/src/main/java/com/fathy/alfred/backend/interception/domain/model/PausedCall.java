package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * A call the proxy is holding while its caller waits, as the inspector shows it.
 *
 * <p>Deliberately NOT persisted anywhere. A paused call only exists for as long as a socket is
 * open on a machine that is still running; a paused call recovered from disk after a restart is a
 * call whose caller gave up long ago, and offering a decision on it would be offering to affect
 * traffic that no longer exists. The registry is in-memory, and a backend restart correctly means
 * every waiting proxy falls back to its rule's own timeout action.
 *
 * <p>The request half is always present even when pausing on the response, because deciding what
 * to send back is impossible without seeing what was asked.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PausedCall(
        /** The same call id the webhook logged this call under, so the inspector and the call list agree. */
        String callId,
        /** "request" (held before forwarding) or "response" (supplier already answered). */
        String phase,
        String source,
        String serviceName,
        String ruleId,
        String ruleName,
        int timeoutSeconds,
        String onTimeout,
        String method,
        String url,
        Http request,
        Http response,
        /** Epoch millis the backend registered this pause - the UI's countdown is derived from it. */
        long pausedAt,
        /**
         * Epoch millis somebody took control of this call, or null while it is still only paused.
         *
         * The distinction is what the timeout actually means. `timeoutSeconds` is a grace period
         * for a HUMAN TO NOTICE - if nobody does, the rule's own onTimeout fires and the caller
         * stops waiting. Once someone has taken control they are evidently at the screen, so the
         * countdown stops and the call waits for their decision instead of being snatched away
         * mid-edit, which is the one thing that makes editing a large body impossible.
         */
        Long heldAt) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Http(Integer status, Map<String, String> headers, String body) {
    }

    /** When the grace period runs out. Meaningless once {@link #heldAt} is set - see {@link #isHeld}. */
    public long expiresAt() {
        return pausedAt + (timeoutSeconds * 1000L);
    }

    public boolean isHeld() {
        return heldAt != null;
    }

    public PausedCall heldNow(long now) {
        return new PausedCall(callId, phase, source, serviceName, ruleId, ruleName, timeoutSeconds,
                onTimeout, method, url, request, response, pausedAt, now);
    }
}
