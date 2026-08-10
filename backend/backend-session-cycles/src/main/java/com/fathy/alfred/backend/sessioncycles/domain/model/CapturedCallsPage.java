package com.fathy.alfred.backend.sessioncycles.domain.model;

import java.util.List;

/** One page of a cycle's captured calls plus the total count matching the query (before pagination). */
public record CapturedCallsPage(List<CapturedCall> calls, int total) {
}
