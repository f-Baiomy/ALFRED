package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

/**
 * One thing a rule does. A flat record with one nullable field per parameter rather than a sealed
 * hierarchy with a subtype per action: this record IS the wire format the proxy reads, and a
 * polymorphic shape would need type discriminators and custom deserialisation on both sides for no
 * gain - the proxy reads it as a plain dict and looks up the keys its own action needs.
 *
 * <p>The cost is that an action carries fields it does not use, which {@link RuleValidator} exists
 * to make harmless: it rejects an action missing a field it requires before the rule is ever
 * written, so the engine never has to decide what a SET_REQUEST_HEADER with no name means.
 *
 * <p>{@code value} is deliberately {@code Object}: SET_QUERY_PARAM wants a string, but
 * SET_*_JSON_FIELD has to be able to write a number, a boolean, null, or a whole object into a
 * body, and forcing those through a string would make {@code "5"} and {@code 5} indistinguishable
 * in the one place where JSON types actually matter.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RuleAction(
        ActionType type,
        /** DELAY_REQUEST / DELAY_RESPONSE. */
        Integer durationMs,
        /** Header or query-parameter name for the SET_/REMOVE_ actions. */
        String name,
        /** SET_REQUEST_HEADER / SET_QUERY_PARAM / SET_*_JSON_FIELD. */
        Object value,
        /** Dotted path for SET_*_JSON_FIELD: {@code a.b[0].c}, {@code segments[*].cabin}. */
        String path,
        /** MOCK_RESPONSE / SET_RESPONSE_STATUS. */
        Integer status,
        /** MOCK_RESPONSE. */
        Map<String, String> headers,
        /** MOCK_RESPONSE. */
        String body,
        /** PAUSE_REQUEST / PAUSE_RESPONSE - how long the caller may be held. */
        Integer timeoutSeconds,
        /** PAUSE_*: "release" or "abort" when the timeout fires with nobody watching. */
        String onTimeout,
        /** SIMULATE_FAILURE - a {@link FailureMode} name. */
        String failure,
        /**
         * IF_REQUEST / IF_RESPONSE: the arms, tried in order, first match wins.
         *
         * <p>Actions nest inside a branch rather than conditions living on the action, because a
         * condition is a step in the pipeline - it sits in the same list as the actions and is
         * moved the same way - not a property bolted onto each one.
         */
        List<ConditionBranch> branches,
        /** IF_REQUEST / IF_RESPONSE: what runs when no branch matched. May be empty. */
        List<RuleAction> otherwise,
        /**
         * Whether the engine actually runs this action. Defaults true - kept in the rule and
         * still validated, just skipped, so a user can try a rule without one action (or swap
         * between two that would otherwise conflict - two terminals, or a terminal and a pause)
         * without deleting and retyping either. Disabling an IF_REQUEST/IF_RESPONSE disables its
         * whole subtree: proxy/interception.py's _prepare_actions simply never builds a disabled
         * action, branches and all, so there is nothing nested left to separately toggle.
         */
        Boolean enabled) {

    public RuleAction {
        headers = headers == null ? null : Map.copyOf(headers);
        branches = branches == null ? null : List.copyOf(branches);
        otherwise = otherwise == null ? null : List.copyOf(otherwise);
        enabled = enabled == null ? Boolean.TRUE : enabled;
    }

    /**
     * The shape before {@code enabled} existed. Kept rather than updating every call site that
     * builds a RuleAction positionally (24 of them, mostly in tests) - an action built this way is
     * always enabled, which is the correct default for anything that predates the field entirely.
     */
    public RuleAction(ActionType type, Integer durationMs, String name, Object value, String path,
                      Integer status, Map<String, String> headers, String body, Integer timeoutSeconds,
                      String onTimeout, String failure, List<ConditionBranch> branches,
                      List<RuleAction> otherwise) {
        this(type, durationMs, name, value, path, status, headers, body, timeoutSeconds, onTimeout, failure,
                branches, otherwise, true);
    }

    public static RuleAction of(ActionType type) {
        return new RuleAction(type, null, null, null, null, null, null, null, null, null, null, null, null, true);
    }

    public boolean isEnabled() {
        return enabled;
    }

    /** Every action this one can lead to, for a validator or a counter that must see them all. */
    public List<RuleAction> nested() {
        if (branches == null && otherwise == null) {
            return List.of();
        }
        List<RuleAction> all = new java.util.ArrayList<>();
        if (branches != null) {
            branches.forEach(branch -> all.addAll(branch.actions()));
        }
        if (otherwise != null) {
            all.addAll(otherwise);
        }
        return all;
    }
}
