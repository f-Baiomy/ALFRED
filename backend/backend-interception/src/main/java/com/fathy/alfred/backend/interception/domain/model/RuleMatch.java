package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Which traffic a rule affects. Every field is optional and an absent field matches anything, so
 * an entirely empty match applies to ALL proxied traffic - which is legal, occasionally what
 * someone wants, and the reason the UI states a rule's match back in plain language and shows how
 * many recent calls it would have hit before the rule is saved.
 *
 * <p>Deliberately a small, fixed set rather than a predicate language. Header, body and
 * response-status matchers were considered and left out of the first cut: the first two invite an
 * expression grammar, and a response-status matcher cannot work at all in the request phase, where
 * the decision to intercept has to be made. See docs/interception.md.
 *
 * <p>{@code source} and {@code serviceName} are the two Alfred-specific matchers and the reason
 * this is not a generic proxy rule: both addons already know, structurally rather than by
 * guessing, which direction a flow is going and which project it belongs to (from the port it
 * arrived on - see proxy/log_and_route_reverse.py's _listen_port).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RuleMatch(
        /** "outbound", "inbound", or null/"both" for either direction. */
        String source,
        /** A configured project name from settings.properties' internal_call_services, or null for any. */
        String serviceName,
        List<String> methods,
        /** Exact host, or a single leading wildcard label: {@code *.sabre.com}. */
        String host,
        String pathContains,
        String pathRegex) {

    public RuleMatch {
        methods = methods == null ? List.of() : List.copyOf(methods);
    }

    public static RuleMatch empty() {
        return new RuleMatch(null, null, List.of(), null, null, null);
    }
}
