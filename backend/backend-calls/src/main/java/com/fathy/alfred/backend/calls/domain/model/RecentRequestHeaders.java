package com.fathy.alfred.backend.calls.domain.model;

import java.util.Map;

/** One recent call's request headers to {@code host} - what {@code useCurrentSession} scans for a session/authorization value. Never the body. */
public record RecentRequestHeaders(String callId, Map<String, String> headers) {

    public RecentRequestHeaders {
        headers = headers == null ? Map.of() : Map.copyOf(headers);
    }
}
