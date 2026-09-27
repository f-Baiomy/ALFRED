package com.fathy.alfred.backend.relive.domain.model;

import java.util.Map;

/**
 * The recorded call as ALFRED already serves it in call detail, copied into the cycle in full
 * (never truncated). The original logged call is never modified by anything in this slice.
 */
public record FrozenCall(
        String method,
        String url,
        Map<String, String> requestHeaders,
        String requestBody,
        int status,
        Map<String, String> responseHeaders,
        String responseBody,
        String timestamp,
        long durationMs,
        String sessionId,
        String operationId,
        String serviceName,
        String source
) {
}
