package com.fathy.alfred.backend.resend.domain.model;

import java.util.List;
import java.util.Map;

/** What a resend produced - per contracts/rest-api.md's {@code 200} body and contracts.md section 2. */
public record ResendResult(String newCallId, int status, long durationMs, List<SessionValueUse> sessionValuesUsed,
                           Response response) {

    public ResendResult {
        sessionValuesUsed = sessionValuesUsed == null ? List.of() : List.copyOf(sessionValuesUsed);
    }

    /** The shape before the supplier response (contracts.md section 2) was carried back. */
    public ResendResult(String newCallId, int status, long durationMs, List<SessionValueUse> sessionValuesUsed) {
        this(newCallId, status, durationMs, sessionValuesUsed, null);
    }

    /**
     * The supplier's response, so chaining (C1) and assertions (B2) need no second fetch. Null
     * when the send failed before a response reached us (the 502 path is unchanged and never
     * reaches this record at all).
     */
    public record Response(int status, Map<String, String> headers, String body) {
        public Response {
            headers = headers == null ? Map.of() : Map.copyOf(headers);
        }
    }
}
