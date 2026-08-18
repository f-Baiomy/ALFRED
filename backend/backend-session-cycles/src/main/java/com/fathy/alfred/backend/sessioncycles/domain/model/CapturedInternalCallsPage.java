package com.fathy.alfred.backend.sessioncycles.domain.model;

import java.util.List;

/** One page of captured-internal-call summaries plus the total count matching the query (before pagination) - mirrors CapturedCallsPage. */
public record CapturedInternalCallsPage(List<CapturedInternalCallSummary> calls, int total) {
}
