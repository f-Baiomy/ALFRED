package com.fathy.alfred.backend.resend.domain.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** What the user changed. A null header value removes that header. Null fields keep the original. */
public record ResendEdits(String method, String url, Map<String, String> headers, String body) {
    public static final ResendEdits NONE = new ResendEdits(null, null, null, null);

    public ResendEdits {
        // Map.copyOf rejects null values, and null means "remove", hence the LinkedHashMap copy.
        headers = headers == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(headers));
    }
}
