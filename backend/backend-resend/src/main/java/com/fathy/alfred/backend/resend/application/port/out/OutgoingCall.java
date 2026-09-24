package com.fathy.alfred.backend.resend.application.port.out;

import java.util.Map;

/**
 * A fully-resolved call ready to send - method/url/headers/body already have every edit and
 * session substitution applied. {@code serviceName} and {@code direction} are what
 * {@code CallSenderPort} uses to pick a forward-proxy port (outbound) or a reverse-proxy listener
 * port (inbound); {@code host} is the target host resend headers are always set against.
 */
public record OutgoingCall(String direction, String method, String url, Map<String, String> headers,
                            String body, String host, String serviceName) {

    public OutgoingCall {
        headers = headers == null ? Map.of() : Map.copyOf(headers);
    }
}
