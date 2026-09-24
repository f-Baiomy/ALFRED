package com.fathy.alfred.backend.internalcalls.domain.model;

import java.util.Map;

/** One recent call's request headers to {@code host} - mirrors backend-calls' own record of the same name. */
public record RecentRequestHeaders(String callId, Map<String, String> headers) {

    public RecentRequestHeaders {
        headers = headers == null ? Map.of() : Map.copyOf(headers);
    }
}
