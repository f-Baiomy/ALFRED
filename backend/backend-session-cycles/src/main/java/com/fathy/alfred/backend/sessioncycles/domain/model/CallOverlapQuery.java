package com.fathy.alfred.backend.sessioncycles.domain.model;

import java.time.Instant;

/**
 * What GET /session-cycles/{id}/call-overlaps is allowed to ask for, scoped to one cycle's own
 * captured calls - mirrors backend-call-overlap's identically-shaped CallOverlapQuery (see
 * CallOverlapEntry's doc for why this slice keeps its own copy rather than sharing that type).
 * {@code search}/{@code supplier} narrow the external side; {@code serviceNames}/{@code sessionId}/
 * {@code operationId}/{@code requestId} narrow the internal side; {@code search} is shared by both.
 * Every filter is optional; blank means "no filter" on that field.
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
