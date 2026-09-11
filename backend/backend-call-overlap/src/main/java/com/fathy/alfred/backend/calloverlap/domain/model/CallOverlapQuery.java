package com.fathy.alfred.backend.calloverlap.domain.model;

import java.time.Instant;

/**
 * What GET /call-overlaps is allowed to ask for. {@code search}/{@code supplier} narrow the
 * external-call side (mirrors GET /calls' own filters); {@code serviceNames}/{@code sessionId}/
 * {@code operationId}/{@code requestId} narrow the internal-call side (mirrors GET /internal-calls'
 * own filters) - {@code search} is shared by both sides. Every filter is optional; blank means "no
 * filter" on that field, same convention as GET /calls and GET /internal-calls.
 */
public record CallOverlapQuery(
        Instant from,
        Instant to,
        String search,
        String supplier,
        String serviceNames,
        String sessionId,
        String operationId,
        String requestId
) {
}
