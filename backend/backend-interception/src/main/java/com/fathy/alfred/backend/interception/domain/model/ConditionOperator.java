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
    AT_MOST(true, false, true);

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
