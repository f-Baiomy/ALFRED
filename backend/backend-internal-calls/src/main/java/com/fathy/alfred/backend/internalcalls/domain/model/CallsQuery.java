package com.fathy.alfred.backend.internalcalls.domain.model;

/**
 * A page request against the internal-calls list. {@code sort} mirrors the frontend's SortMode
 * values ("newest", "oldest", "newest-call", "oldest-call", "slowest", "fastest", "status") -
 * "custom" (drag-and-drop order) is deliberately not one of them, since that's a manual
 * arrangement of whatever a session-cycle detail page already has loaded, not a data ordering the
 * backend knows about (this slice has no session-cycles integration at all, but the sort values
 * stay identical to backend-calls' so the shared frontend query-building code needs no branching).
 *
 * @param serviceNames Comma-separated project names (matching CallRecord.serviceName, "unknown"
 *                      included) to narrow the list to - blank/empty means no filter (every
 *                      project). Combined with every other filter via AND, same as supplier/search.
 */
public record CallsQuery(String search, String supplier, String sort, int offset, int limit,
                          String sessionId, String operationId, String requestId, String serviceNames) {

    /** Pre-serviceNames shape - kept so a call site built before that filter existed doesn't need to pass it explicitly. Blank means "no filter", i.e. every project. */
    public CallsQuery(String search, String supplier, String sort, int offset, int limit,
                       String sessionId, String operationId, String requestId) {
        this(search, supplier, sort, offset, limit, sessionId, operationId, requestId, "");
    }
}
