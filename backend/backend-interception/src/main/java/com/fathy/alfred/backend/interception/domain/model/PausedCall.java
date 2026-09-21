package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * A call the inspector is showing: one the proxy is holding, one it has let go and is following,
 * or one whose cycle is over and is waiting to be closed.
 *
 * <p>Deliberately NOT persisted anywhere. A held call only exists for as long as a socket is open
 * on a machine that is still running; a held call recovered from disk after a restart is a call
 * whose caller gave up long ago, and offering a decision on it would be offering to affect traffic
 * that no longer exists. The registry is in-memory, and a backend restart correctly means every
 * waiting proxy falls back to its rule's own timeout action. A FINISHED card lost on restart is
 * only mildly annoying by comparison - the call itself is in the call log either way.
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
        Long heldAt,
        /** Holding a caller, in flight upstream, or done. Never null - see the compact constructor. */
        PauseStage stage,
        /** Everything about following this call past the half it was paused on. Never null. */
        Cycle cycle) {

    public PausedCall {
        stage = stage == null ? PauseStage.HOLDING : stage;
        cycle = cycle == null ? Cycle.notFollowed() : cycle;
    }

    /** The shape the proxy registers a fresh pause in - stage and cycle are ours to decide. */
    public PausedCall(String callId, String phase, String source, String serviceName, String ruleId,
                      String ruleName, int timeoutSeconds, String onTimeout, String method, String url,
                      Http request, Http response, long pausedAt, Long heldAt) {
        this(callId, phase, source, serviceName, ruleId, ruleName, timeoutSeconds, onTimeout, method, url,
                request, response, pausedAt, heldAt, PauseStage.HOLDING, Cycle.notFollowed());
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Http(Integer status, Map<String, String> headers, String body) {
    }

    /**
     * What has happened to this call beyond the one half a rule paused it on.
     *
     * <p>Kept as a nested record rather than eight more components on {@link PausedCall} because
     * every one of them is null for the overwhelmingly common case - a call that was paused,
     * decided and closed - and a sixteen-component record whose last eight are usually null is a
     * record nobody can call correctly.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Cycle(
            /** Whether the user asked to be stopped again when the supplier answers. */
            boolean follow,
            /** Epoch millis the request half was released by a human. */
            Long releasedAt,
            /** Epoch millis the whole cycle ended. */
            Long finishedAt,
            /** How long the caller waited, end to end, once known. */
            Long durationMs,
            /** "completed", "aborted", "failed" or "never-came-back". Null until finished. */
            String outcome,
            /** Free text for an outcome that needs one - the error that killed a followed call. */
            String note,
            /** What the user changed on the way out, in apply_decision's own words. Null if nothing. */
            String requestEdit,
            /** The same for the response half. */
            String responseEdit) {

        public static Cycle notFollowed() {
            return new Cycle(false, null, null, null, null, null, null, null);
        }

        public Cycle released(boolean follow, long at, String edit) {
            return new Cycle(follow, at, finishedAt, durationMs, outcome, note, edit, responseEdit);
        }

        public Cycle finished(long at, String outcome, String note, String responseEdit) {
            Long duration = releasedAt == null ? null : at - releasedAt;
            return new Cycle(follow, releasedAt, at, duration, outcome, note, requestEdit,
                    responseEdit == null ? this.responseEdit : responseEdit);
        }
    }

    /** When the grace period runs out. Meaningless once {@link #heldAt} is set - see {@link #isHeld}. */
    public long expiresAt() {
        return pausedAt + (timeoutSeconds * 1000L);
    }

    public boolean isHeld() {
        return heldAt != null;
    }

    /** Whether a real client socket is open on the other end of this row right now. */
    public boolean holdsCaller() {
        return stage.holdsCaller();
    }

    public PausedCall heldNow(long now) {
        return new PausedCall(callId, phase, source, serviceName, ruleId, ruleName, timeoutSeconds,
                onTimeout, method, url, request, response, pausedAt, now, stage, cycle);
    }

    public PausedCall at(PauseStage next, Cycle cycle) {
        // heldAt is cleared on the way out of HOLDING: it is the "somebody stopped the countdown"
        // marker, and a stage with no countdown must not keep showing a held badge.
        return new PausedCall(callId, phase, source, serviceName, ruleId, ruleName, timeoutSeconds,
                onTimeout, method, url, request, response, pausedAt,
                next.holdsCaller() ? heldAt : null, next, cycle);
    }

    /** The response half arriving on a call that was followed, with the cycle carried across. */
    public PausedCall withResponse(Http response) {
        return new PausedCall(callId, phase, source, serviceName, ruleId, ruleName, timeoutSeconds,
                onTimeout, method, url, request, response, pausedAt, heldAt, stage, cycle);
    }

    /**
     * The same card without the two bodies and their headers - everything the QUEUE draws, and
     * nothing it doesn't.
     *
     * <p>This exists because the list endpoint is re-read constantly. A card carries a whole
     * request and a whole response, and a supplier search measured here runs 250-300 KB; the
     * dashboard re-fetches the list on every paused-changed event (register, take control, decide,
     * resolve, complete - several a second while somebody is working), once per open tab. Six held
     * calls made that response 1.75 MB. At twenty or thirty cards it is 6-9 MB of JSON built and
     * thrown away several times a second, which is enough to exhaust the heap on its own: measured
     * live as OutOfMemoryError, after which the backend accepts connections and answers nothing.
     *
     * <p>The response status stays, because the queue shows it. The bodies arrive separately when
     * a card is actually opened - the same lazy shape the call list already uses (CallSummaryDto
     * plus /calls/{id}/detail).
     */
    public PausedCall summary() {
        Http responseSummary = response == null ? null : new Http(response.status(), null, null);
        return new PausedCall(callId, phase, source, serviceName, ruleId, ruleName, timeoutSeconds,
                onTimeout, method, url, null, responseSummary, pausedAt, heldAt, stage, cycle);
    }
}
