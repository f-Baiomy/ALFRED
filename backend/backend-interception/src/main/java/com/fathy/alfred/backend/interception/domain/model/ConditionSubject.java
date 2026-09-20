package com.fathy.alfred.backend.interception.domain.model;

/**
 * What part of a call a {@link Condition} looks at. The names are the wire format, matched by
 * string in proxy/interception.py's SUBJECTS.
 *
 * <p>Response subjects are legal only inside an {@code IF_RESPONSE}: in the request phase there is
 * no response to read, so a condition on one could only ever be false, and a rule whose branch can
 * never be taken is better rejected at save time than left to puzzle someone later. The reverse is
 * NOT true - reading a REQUEST subject from the response phase is one of the main reasons to have
 * conditions at all ("if we sent X and got back Y").
 */
public enum ConditionSubject {

    REQUEST_HEADER(true, false),
    /** The whole request body, as text. */
    REQUEST_BODY(false, false),
    /** One field inside a JSON request body, by the same dotted path SET_REQUEST_JSON_FIELD takes. */
    REQUEST_JSON_FIELD(true, false),
    QUERY_PARAM(true, false),
    /** The full URL, query string included. */
    URL(false, false),
    METHOD(false, false),

    RESPONSE_STATUS(false, true),
    RESPONSE_HEADER(true, true),
    RESPONSE_BODY(false, true),
    RESPONSE_JSON_FIELD(true, true);

    private final boolean needsName;
    private final boolean response;

    ConditionSubject(boolean needsName, boolean response) {
        this.needsName = needsName;
        this.response = response;
    }

    /** Whether a header name, parameter name or field path is required to identify the value. */
    public boolean needsName() {
        return needsName;
    }

    public boolean isResponse() {
        return response;
    }
}
