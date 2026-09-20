package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One test against a call: a subject, an operator, and usually a value.
 *
 * <p>Subject / operator / value, not an expression language. The moment a condition becomes
 * {@code req.headers['x'] ~= /y/ && ...} it needs a parser, an error surface and a manual - and
 * the entire point of this feature is that reproducing a broken supplier should not require
 * writing code into a proxy addon. The cost is that some tests are not expressible; the benefit is
 * that a rule can be read and trusted by someone who did not write it, which matters when the rule
 * is changing production-shaped traffic.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Condition(
        ConditionSubject subject,
        /** Header name, query parameter name, or dotted JSON path - see {@link ConditionSubject#needsName()}. */
        String name,
        ConditionOperator operator,
        /** Absent for EXISTS / NOT_EXISTS, which compare against nothing. */
        String value,
        /**
         * Defaults to false: HTTP header names are case-insensitive and header VALUES are so
         * routinely inconsistent between suppliers that an exact-case comparison is more often a
         * bug than an intention. Set it when the case is the thing being tested.
         */
        Boolean caseSensitive) {

    public boolean isCaseSensitive() {
        return Boolean.TRUE.equals(caseSensitive);
    }
}
