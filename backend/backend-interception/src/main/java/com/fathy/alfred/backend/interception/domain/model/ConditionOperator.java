package com.fathy.alfred.backend.interception.domain.model;

/**
 * How a {@link Condition}'s subject is compared to its value. The names are the wire format,
 * matched by string in proxy/interception.py's OPERATORS.
 *
 * <p><b>An absent subject is never equal to, does not contain, and does not match anything.</b> So
 * {@code NOT_EQUALS} against a header that was never sent is TRUE, which is defensible but
 * surprising - and is exactly why {@link #EXISTS} and {@link #NOT_EXISTS} are here: to say
 * "this is missing" outright instead of leaving it to be inferred from a negative comparison.
 */
public enum ConditionOperator {

    EXISTS(false, false, false),
    NOT_EXISTS(false, false, false),
    EQUALS(true, false, false),
    NOT_EQUALS(true, false, false),
    CONTAINS(true, false, false),
    NOT_CONTAINS(true, false, false),
    MATCHES(true, true, false),
    NOT_MATCHES(true, true, false),
    /** Numeric, for a status or a JSON number. A non-numeric subject makes it false, never an error. */
    AT_LEAST(true, false, true),
    AT_MOST(true, false, true),
    STARTS_WITH(true, false, false),
    ENDS_WITH(true, false, false),
    /** Equals any of {@link Condition#values()}. */
    IN(false, false, false),
    /** JSON fields only: the JSON type - text, number, boolean, null, object or list. */
    TYPE_IS(true, false, false),
    /** JSON fields only: "", [], {} or null - or not there at all. */
    IS_EMPTY(false, false, false),
    /** JSON fields only: how many items the field resolves to (a list's length, or a [*] path's matches). */
    COUNT_AT_LEAST(true, false, true),
    COUNT_AT_MOST(true, false, true),
    COUNT_EQUALS(true, false, true),
    /** JSON fields only: every one of {@link Condition#values()} is among the items, in any order. */
    CONTAINS_ALL(false, false, false);

    /** The JSON types TYPE_IS takes - proxy/interception.py's _json_type names the same six. */
    public static final java.util.Set<String> JSON_TYPES = java.util.Set.of("text", "number", "boolean", "null", "object", "list");

    /** The operators that only mean something on a JSON field. */
    public boolean jsonOnly() {
        return this == TYPE_IS || this == IS_EMPTY || this == COUNT_AT_LEAST || this == COUNT_AT_MOST
                || this == COUNT_EQUALS || this == CONTAINS_ALL;
    }

    /** Compare against a list of values rather than one. */
    public boolean takesValues() {
        return this == IN || this == CONTAINS_ALL;
    }

    /** About the field as a whole (its item count / its values as a set) - an item mode means nothing. */
    public boolean wholeField() {
        return this == COUNT_AT_LEAST || this == COUNT_AT_MOST || this == COUNT_EQUALS || this == CONTAINS_ALL;
    }

    public boolean negative() {
        return name().startsWith("NOT_");
    }

    private final boolean needsValue;
    private final boolean regex;
    private final boolean numeric;

    ConditionOperator(boolean needsValue, boolean regex, boolean numeric) {
        this.needsValue = needsValue;
        this.regex = regex;
        this.numeric = numeric;
    }

    public boolean needsValue() {
        return needsValue;
    }

    public boolean isRegex() {
        return regex;
    }

    public boolean isNumeric() {
        return numeric;
    }
}
