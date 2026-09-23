package com.fathy.alfred.backend.resend.domain.model;

import java.util.Map;

/** What is actually sent. */
public record OutgoingCall(String direction, String method, String url, Map<String, String> headers,
                            String body, String serviceName) {
}
