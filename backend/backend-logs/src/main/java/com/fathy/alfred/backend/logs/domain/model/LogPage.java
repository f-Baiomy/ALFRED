package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;

/** One keyset page of lines. {@code slow} = the query had to scan (short text term, unindexed field). */
public record LogPage(List<LogLineSummary> lines, long total, String nextCursor, long tookMs, boolean slow) {
}
