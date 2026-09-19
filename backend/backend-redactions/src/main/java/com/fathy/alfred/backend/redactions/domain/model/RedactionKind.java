package com.fathy.alfred.backend.redactions.domain.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * What part of a call a redaction's {@code name} points into - it tells the export-time masker
 * where to look the name up. In every case the name is an identifier, never a value.
 *
 * <p>The wire values are kebab-case rather than the Java constant names. That is the convention
 * this API already established: {@code Comment.block} is a plain String carrying
 * {@code request-headers}/{@code response-body}, so a redaction arriving as {@code REQUEST_HEADER}
 * would be the odd one out for a client reading both. An enum is still used here (unlike Comment's
 * String) so an unknown kind is rejected at the boundary instead of being stored and silently
 * masking nothing at export time.
 */
public enum RedactionKind {

    /** {@code name} is a request header name, e.g. {@code authorization}. */
    REQUEST_HEADER("request-header"),

    /** {@code name} is a response header name, e.g. {@code set-cookie}. */
    RESPONSE_HEADER("response-header"),

    /** {@code name} is a key in the request body, e.g. {@code password}. */
    REQUEST_BODY_KEY("request-body-key"),

    /** {@code name} is a key in the response body, e.g. {@code access_token}. */
    RESPONSE_BODY_KEY("response-body-key"),

    /** {@code name} is a query-parameter name from the URL, e.g. {@code credential}. */
    URL_PARAM("url-param");

    private final String wireValue;

    RedactionKind(String wireValue) {
        this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
        return wireValue;
    }

    @JsonCreator
    public static RedactionKind fromWireValue(String value) {
        if (value != null) {
            for (RedactionKind kind : values()) {
                // name() is accepted too so a redactions file written before the wire values were
                // settled still reads back rather than failing the whole store.
                if (kind.wireValue.equalsIgnoreCase(value) || kind.name().equalsIgnoreCase(value)) {
                    return kind;
                }
            }
        }
        throw new IllegalArgumentException("Unknown redaction kind: " + value);
    }
}
