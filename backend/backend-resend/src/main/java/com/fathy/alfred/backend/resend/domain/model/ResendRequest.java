package com.fathy.alfred.backend.resend.domain.model;

import java.util.Map;

/** A request to resend a logged call through Alfred's own proxies. */
public record ResendRequest(String direction, String callId, String cycleId, ResendEdits edits,
                            boolean useCurrentSession, ResendBatch batch,
                            Map<String, String> variables, Map<String, String> fallbacks) {
    public ResendRequest {
        variables = variables == null ? Map.of() : Map.copyOf(variables);
        fallbacks = fallbacks == null ? Map.of() : Map.copyOf(fallbacks);
    }
    public ResendRequest(String direction, String callId, String cycleId, ResendEdits edits, boolean useCurrentSession, ResendBatch batch) {
        this(direction, callId, cycleId, edits, useCurrentSession, batch, Map.of(), Map.of());
    }
    public ResendRequest(String direction, String callId, String cycleId, ResendEdits edits, boolean useCurrentSession) {
        this(direction, callId, cycleId, edits, useCurrentSession, null, Map.of(), Map.of());
    }
}
