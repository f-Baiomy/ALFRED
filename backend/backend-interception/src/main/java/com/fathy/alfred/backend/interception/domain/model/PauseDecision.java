package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * What a human decided about a paused call. Handed back to the waiting proxy verbatim and applied
 * by proxy/interception.py's apply_decision.
 *
 * <p>Every field except {@code action} is nullable and means "leave this alone". That is what
 * makes "send unchanged" byte-identical to never having paused at all: an untouched release
 * carries no status, no headers and no body, so nothing is rewritten and a body that was never
 * edited is never re-serialised.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PauseDecision(
        /** "release" or "abort". */
        String action,
        Integer status,
        /** A null VALUE inside this map removes that header; an absent key leaves it untouched. */
        Map<String, String> headers,
        String body,
        /** Set by the backend, not the user: "timeout", "backend-unreachable", or null for a real decision. */
        String reason) {

    /**
     * Not a decision at all - the signal that a human has taken control, handed to the waiting
     * proxy so it stops counting down and keeps holding. The proxy recognises it by
     * {@code action} and applies nothing.
     */
    public static PauseDecision hold() {
        return new PauseDecision("hold", null, null, null, "taken-control");
    }

    public static PauseDecision release() {
        return new PauseDecision("release", null, null, null, null);
    }

    public static PauseDecision timedOut(String onTimeout) {
        return new PauseDecision("abort".equals(onTimeout) ? "abort" : "release", null, null, null, "timeout");
    }

    public boolean isAbort() {
        return "abort".equals(action);
    }
}
