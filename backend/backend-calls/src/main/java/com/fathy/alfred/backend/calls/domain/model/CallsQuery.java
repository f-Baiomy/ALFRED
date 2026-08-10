package com.fathy.alfred.backend.calls.domain.model;

/**
 * A page request against any list of calls - shared verbatim by GET /calls (CallRecord itself)
 * and GET /session-cycles/{id}/calls (CapturedCall, which wraps one), so both endpoints filter,
 * search, sort, and paginate identically. {@code sort} mirrors the frontend's SortMode values
 * ("newest", "oldest", "newest-call", "oldest-call", "slowest", "fastest", "status") - "custom"
 * (drag-and-drop order) is deliberately not one of them, since that's a manual arrangement of
 * whatever a session-cycle detail page already has loaded, not a data ordering the backend knows
 * about.
 */
public record CallsQuery(String search, String supplier, String sort, int offset, int limit) {
}
