package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

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
        String onTimeout) {

    public RuleAction {
        headers = headers == null ? null : Map.copyOf(headers);
    }

    public static RuleAction of(ActionType type) {
        return new RuleAction(type, null, null, null, null, null, null, null, null, null);
    }
}
