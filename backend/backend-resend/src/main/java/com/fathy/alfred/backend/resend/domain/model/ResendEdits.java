package com.fathy.alfred.backend.resend.domain.model;

import java.util.Map;

/**
 * What the user changed before resending a logged call - everything is optional; a null field
 * means "keep what the original call had". A header whose value is {@code null} inside
 * {@code headers} is a request to remove that header entirely, distinct from an absent key
 * (unchanged) or an empty string (set to blank).
 */
public record ResendEdits(String method, String url, Map<String, String> headers, String body) {

    public ResendEdits {
        headers = headers == null ? null : new java.util.LinkedHashMap<>(headers);
    }

    public boolean isEmpty() {
        return method == null && url == null && (headers == null || headers.isEmpty()) && body == null;
    }
}
