package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * A value as a person reads it (specs/011-redis-capture research R11): its format ("JDK serialization",
 * "Jackson JSON + gzip", "raw", …), the class when known, the text, whether part of it could only be shown as bytes.
 * {@code masked}: the key matched a masked pattern - no text, only the size. {@code rawBase64}: the stored bytes,
 * only when asked for (Raw bytes). Decoding never changes what is stored.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DecodedValue(String format, String className, String text, boolean partial, boolean masked, long bytes, String rawBase64) {

    public static DecodedValue masked(long bytes) {
        return new DecodedValue(null, null, null, false, true, bytes, null);
    }

    public DecodedValue withRaw(String base64) {
        return new DecodedValue(format, className, text, partial, masked, bytes, masked ? null : base64);
    }
}
