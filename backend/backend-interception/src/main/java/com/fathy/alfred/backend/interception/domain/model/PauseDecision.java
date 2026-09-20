package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.List;
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
        String reason,
        /**
         * Stop this call a second time when the supplier answers.
         *
         * Only meaningful releasing a REQUEST half. Note this is not what keeps the card on
         * screen - a call a human decided on is always followed to the end of its cycle. This is
         * only whether Alfred holds the caller again at the other end.
         */
        boolean follow) {

    /**
     * Not a decision at all - the signal that a human has taken control, handed to the waiting
     * proxy so it stops counting down and keeps holding. The proxy recognises it by
     * {@code action} and applies nothing.
     */
    public static PauseDecision hold() {
        return new PauseDecision("hold", null, null, null, "taken-control", false);
    }

    public static PauseDecision release() {
        return new PauseDecision("release", null, null, null, null, false);
    }

    public static PauseDecision timedOut(String onTimeout) {
        return new PauseDecision("abort".equals(onTimeout) ? "abort" : "release", null, null, null, "timeout", false);
    }

    public boolean isAbort() {
        return "abort".equals(action);
    }

    public boolean isHold() {
        return "hold".equals(action);
    }

    /**
     * Whether a person made this decision, as opposed to a clock or a broken connection.
     *
     * This is what decides whether the call leaves a card behind. Following a call through its
     * whole cycle is for calls you are actually working on; a rule that pauses everything on busy
     * traffic times out dozens of calls nobody ever looked at, and leaving a card for each of
     * those would bury the one you care about under the ones you never saw.
     */
    public boolean isFromUser() {
        return reason == null;
    }

    /**
     * What this decision changes, in a few words, or null when it changes nothing.
     *
     * <p>Derived here rather than reported back by the proxy: the decision already says exactly
     * what the user asked for, so asking the proxy to describe it too would be a second round
     * trip on the request path to learn something we already know.
     *
     * <p><b>Header NAMES only, never values.</b> This string is shown in the inspector and could
     * end up anywhere a card is read from; a summary saying {@code authorization: Bearer ey...}
     * would leak a credential into a place that has no business holding one. The same rule the
     * redaction records follow - store what was touched, never what it was.
     */
    public String editSummary() {
        if (isAbort()) {
            return "aborted";
        }
        List<String> changed = new ArrayList<>();
        if (status != null) {
            changed.add("status " + status);
        }
        if (headers != null) {
            headers.forEach((name, value) -> changed.add(value == null ? "-" + name : "header " + name));
        }
        if (body != null) {
            changed.add("body");
        }
        return changed.isEmpty() ? null : String.join(", ", changed);
    }
}
