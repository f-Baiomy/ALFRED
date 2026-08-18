package com.fathy.alfred.backend.internalcalls.domain.model;

/**
 * A page request against the internal-calls list. {@code sort} mirrors the frontend's SortMode
 * values ("newest", "oldest", "newest-call", "oldest-call", "slowest", "fastest", "status") -
 * "custom" (drag-and-drop order) is deliberately not one of them, since that's a manual
 * arrangement of whatever a session-cycle detail page already has loaded, not a data ordering the
 * backend knows about (this slice has no session-cycles integration at all, but the sort values
 * stay identical to backend-calls' so the shared frontend query-building code needs no branching).
 */
public record CallsQuery(String search, String supplier, String sort, int offset, int limit,
                          String sessionId, String operationId, String requestId) {
}
