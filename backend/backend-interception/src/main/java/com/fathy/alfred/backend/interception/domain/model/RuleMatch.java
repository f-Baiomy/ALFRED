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
        /**
         * Superseded by {@link #serviceNames} and always null on anything written since. Read on
         * the way in so a rule saved before the field was a list keeps matching exactly what it
         * used to; the compact constructor folds it into the list and clears it, so there is one
         * shape in storage, in the published snapshot and in the engine rather than two.
         */
        @Deprecated
        String serviceName,
        /**
         * Configured project names from settings.properties' internal_call_services. ANY of them
         * matches; empty means any project at all.
         *
         * <p>A list rather than one name because the natural unit of a test is "our own services"
         * or "everything except the legacy one" - expressing that with one name per rule means
         * maintaining three copies of a rule that must stay identical.
         */
        List<String> serviceNames,
        List<String> methods,
        /** Exact host, or a single leading wildcard label: {@code *.sabre.com}. */
        String host,
        String pathContains,
        String pathRegex) {

    public RuleMatch {
        methods = methods == null ? List.of() : List.copyOf(methods);
        serviceNames = serviceNames == null ? List.of() : List.copyOf(serviceNames);
        if (serviceNames.isEmpty() && serviceName != null && !serviceName.isBlank()) {
            serviceNames = List.of(serviceName);
        }
        serviceName = null;
    }

    public static RuleMatch empty() {
        return new RuleMatch(null, null, List.of(), List.of(), null, null, null);
    }
}
