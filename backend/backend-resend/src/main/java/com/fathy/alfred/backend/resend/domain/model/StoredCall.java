package com.fathy.alfred.backend.resend.domain.model;

import java.util.Map;

/**
 * A logged call's request side, as read back from whichever slice originally logged it (calls,
 * internal-calls, or a session-cycle's captured copy) through {@code CallSourcePort}. Only what
 * resending needs to replay - no response, no interception record.
 *
 * @param direction "outbound" or "inbound" - which proxy the resend must go back through.
 * @param host      the original call's target host, used to resolve the outbound service's
 *                   forward-proxy port or the inbound listener port.
 * @param serviceName the internal project name (inbound), or null for an outbound call.
 */
public record StoredCall(String direction, String id, String method, String url,
                          Map<String, String> headers, String body, String host, String serviceName) {

    public StoredCall {
        headers = headers == null ? Map.of() : Map.copyOf(headers);
    }
}
