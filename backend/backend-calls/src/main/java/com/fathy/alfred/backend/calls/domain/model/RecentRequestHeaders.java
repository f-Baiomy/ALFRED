package com.fathy.alfred.backend.calls.domain.model;

import java.util.Map;

/** One call's request headers, for "resend with current session" - never bodies. */
public record RecentRequestHeaders(String callId, String timestamp, Map<String, String> headers) {
}
