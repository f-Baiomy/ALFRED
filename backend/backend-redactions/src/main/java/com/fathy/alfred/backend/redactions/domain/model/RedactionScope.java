package com.fathy.alfred.backend.redactions.domain.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** How widely a redaction applies. Wire values are lowercase - see RedactionKind for why. */
public enum RedactionScope {

    /** Applies to exactly one call - {@code callId} identifies it. */
    CALL("call"),

    /**
     * Applies to every call in any export - {@code callId} is null. This is what makes hiding
     * {@code authorization} across a 40-call capture one decision rather than forty, and it covers
     * calls captured after the decision was made.
     */
    ALL("all");

    private final String wireValue;

    RedactionScope(String wireValue) {
        this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
        return wireValue;
    }

    @JsonCreator
    public static RedactionScope fromWireValue(String value) {
        if (value != null) {
            for (RedactionScope scope : values()) {
                if (scope.wireValue.equalsIgnoreCase(value) || scope.name().equalsIgnoreCase(value)) {
                    return scope;
                }
            }
        }
        throw new IllegalArgumentException("Unknown redaction scope: " + value);
    }
}
