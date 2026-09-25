package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.EnumSet;
import java.util.Set;

/**
 * One test on the REQUEST body in a rule's match: "body CONTAINS &lt;Currency&gt;EUR", "JSON field
 * passengers[*].type EQUALS CHD", "body size AT_MOST 20000". Like a {@link MatchTest}, every test
 * must hold for the rule to match at all - a failed one is "this rule is not for this call", not a
 * branch.
 *
 * <p>Evaluated in the proxy last, after every cheaper matcher (direction, project, method, host,
 * path, header/query/cookie tests) has already let the call through, so most calls never have
 * their body read for this. The comparison itself is proxy/interception.py's {@code Condition}
 * evaluator - the same one IF_REQUEST uses on REQUEST_BODY / REQUEST_JSON_FIELD - so the two can
 * never disagree about what "contains" means.
 *
 * @param kind             what is tested: the whole body text, one JSON field, or the body's size
 * @param path             the dotted JSON path, JSON_FIELD only ({@code itinerary.price},
 *                         {@code passengers[*].type})
 * @param value            required for every operator except EXISTS / NOT_EXISTS; a number for
 *                         AT_LEAST / AT_MOST
 * @param caseSensitive    for the text operators; defaults to true
 * @param ignoreFormatting BODY and JSON_FIELD text tests only: compare JSON by content and XML with
 *                         the whitespace between tags removed, on both sides - so a pretty-printed
 *                         value matches a minified call. Defaults to true
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record BodyTest(Kind kind, String path, Operator operator, String value, Boolean caseSensitive, Boolean ignoreFormatting) {

    public enum Kind { BODY, JSON_FIELD, SIZE }

    public enum Operator { EXISTS, NOT_EXISTS, EQUALS, NOT_EQUALS, CONTAINS, NOT_CONTAINS, MATCHES, NOT_MATCHES, AT_LEAST, AT_MOST }

    private static final Set<Operator> TEXT = EnumSet.of(
            Operator.EQUALS, Operator.NOT_EQUALS, Operator.CONTAINS, Operator.NOT_CONTAINS, Operator.MATCHES, Operator.NOT_MATCHES);

    /** Which operators each kind takes - a body has no "at least", a size has no "contains". */
    public Set<Operator> allowedOperators() {
        return switch (kind) {
            case BODY -> {
                Set<Operator> ops = EnumSet.copyOf(TEXT);
                ops.add(Operator.EXISTS);
                ops.add(Operator.NOT_EXISTS);
                yield ops;
            }
            case JSON_FIELD -> EnumSet.allOf(Operator.class);
            case SIZE -> EnumSet.of(Operator.AT_LEAST, Operator.AT_MOST);
        };
    }

    public boolean needsValue() {
        return operator != Operator.EXISTS && operator != Operator.NOT_EXISTS;
    }

    public boolean numeric() {
        return operator == Operator.AT_LEAST || operator == Operator.AT_MOST;
    }

    public boolean regex() {
        return operator == Operator.MATCHES || operator == Operator.NOT_MATCHES;
    }
}
