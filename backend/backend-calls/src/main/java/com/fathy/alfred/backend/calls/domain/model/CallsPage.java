package com.fathy.alfred.backend.calls.domain.model;

import java.util.List;

/** One page of call summaries (no request/response headers/bodies - see CallSummary) plus the total count matching the query (before pagination) - lets the frontend know whether "Load more" has anything left without fetching everything. */
public record CallsPage(List<CallSummary> calls, int total) {
}
