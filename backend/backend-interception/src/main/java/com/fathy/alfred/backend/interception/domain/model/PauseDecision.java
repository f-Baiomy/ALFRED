package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * What a human decided about a paused call. Handed back to the waiting proxy verbatim and applied
 * by proxy/interception.py's apply_decision - except {@code action: "simulate_failure"}, which
 * goes through failure_plan instead, the same function a rule's SIMULATE_FAILURE action already
 * uses.
 *
 * <p>Every field except {@code action} is nullable and means "leave this alone". That is what
 * makes "send unchanged" byte-identical to never having paused at all: an untouched release
 * carries no status, no headers and no body, so nothing is rewritten and a body that was never
 * edited is never re-serialised.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PauseDecision(
        /** "release", "abort", or "simulate_failure". */
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
        boolean follow,
        /** action: "simulate_failure" only. */
        PauseFailure failure) {

    /**
     * A "simulate_failure" decision's payload - exactly the fields {@link RuleAction}'s
     * SIMULATE_FAILURE already carries ({@code failure}/{@code durationMs}/{@code status}/
     * {@code body}), just grouped under one key here since a decision has no other use for those
     * four names. Handed to the waiting proxy verbatim and read by
     * proxy/interception.py's failure_plan - the SAME function a rule's SIMULATE_FAILURE action
     * already goes through, so a mode means exactly the same thing whether a rule chose it ahead
     * of time or a human chose it here, by hand, while looking at a real call.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PauseFailure(
            /** A {@link FailureMode} name. */
            String mode,
            /** HANG_THEN_DROP only. */
            Integer durationMs,
            /** GATEWAY_ERROR only. */
            Integer status,
            /** TRUNCATED_BODY only. */
            String body) {
    }

    /**
     * The shape before {@code failure} existed. Kept rather than updating every call site that
     * builds a PauseDecision positionally (mostly tests) - a decision built this way can never be
     * a "simulate_failure" one, which is the correct reading for anything that predates the
     * action entirely.
     */
    public PauseDecision(String action, Integer status, Map<String, String> headers, String body,
            String reason, boolean follow) {
        this(action, status, headers, body, reason, follow, null);
    }

    /**
     * Not a decision at all - the signal that a human has taken control, handed to the waiting
     * proxy so it stops counting down and keeps holding. The proxy recognises it by
     * {@code action} and applies nothing.
     */
    public static PauseDecision hold() {
        return new PauseDecision("hold", null, null, null, "taken-control", false, null);
    }

    public static PauseDecision release() {
        return new PauseDecision("release", null, null, null, null, false, null);
    }

    public static PauseDecision timedOut(String onTimeout) {
        return new PauseDecision(
                "abort".equals(onTimeout) ? "abort" : "release", null, null, null, "timeout", false, null);
    }

    public boolean isAbort() {
        return "abort".equals(action);
    }

    public boolean isHold() {
        return "hold".equals(action);
    }

    public boolean isSimulateFailure() {
        return "simulate_failure".equals(action);
    }

    /**
     * Whether this decision ends the call with nothing reaching the caller, the way an abort
     * does - as opposed to a release, or a simulated failure whose mode still sends back a
     * deliberately broken response (EMPTY_REPLY, TRUNCATED_BODY, GATEWAY_ERROR all reach the
     * caller; only the connection-killing modes do not). This is the one thing
     * BreakpointService's bookkeeping actually needs to know about a decision it otherwise
     * treats like any other - which of its two existing paths applies - so a mocked
     * CONNECTION_RESET finishes a card as "aborted" exactly like a plain abort does, rather than
     * being mistaken for a release that is still waiting on a response that will never come.
     */
    public boolean endsConnection() {
        if (isAbort()) {
            return true;
        }
        return isSimulateFailure() && failure != null
                && FailureMode.isKnown(failure.mode())
                && FailureMode.valueOf(failure.mode()).killsConnection();
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
        if (isSimulateFailure() && failure != null) {
            return "network failure: " + failure.mode();
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
