package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One header, query-parameter or cookie test in a rule's match: "header X-Tenant EQUALS acme",
 * "cookie session EXISTS". Every test in every list must hold for the rule to match.
 *
 * <p>Evaluated in the proxy after the cheap checks (direction, project, method, host, path), so a
 * call those already rule out never has its headers read. Unlike an {@code IF_REQUEST} condition,
 * a failed test means the rule did not match at all - its {@code stopProcessing} does not fire and
 * later rules still get their turn, which is the point of putting the test here.
 *
 * @param name          the header, parameter or cookie name; headers and cookies compare it
 *                      case-insensitively, query parameters exactly
 * @param value         required for every operator except EXISTS and NOT_EXISTS
 * @param caseSensitive for EQUALS, CONTAINS and MATCHES on the value; defaults to true
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MatchTest(String name, Operator operator, String value, Boolean caseSensitive) {

    public enum Operator { EXISTS, NOT_EXISTS, EQUALS, CONTAINS, MATCHES }

    public boolean needsValue() {
        return operator != Operator.EXISTS && operator != Operator.NOT_EXISTS;
    }
}
