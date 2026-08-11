package com.fathy.alfred.backend.sessioncycles.domain.model;

import java.util.List;

/** One page of captured-call summaries (no request/response headers/bodies - see CapturedCallSummary) plus the total count matching the query (before pagination). */
public record CapturedCallsPage(List<CapturedCallSummary> calls, int total) {
}
