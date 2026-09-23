package com.fathy.alfred.backend.resend.domain.model;

import java.util.Map;

/** The fields of a logged call a resend needs. originalUrl is what the client asked for. */
public record StoredCall(String direction, String id, String method, String originalUrl,
                          Map<String, String> headers, String body, String serviceName) {
    public StoredCall {
        headers = headers == null ? Map.of() : Map.copyOf(headers);
    }
}
