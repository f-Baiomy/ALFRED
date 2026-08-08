package com.alfred.pennyworth.sessioncycles.domain.model;

/** Result of copying a bulk-selected set of calls into a cycle - skipped counts calls already present (matched by content), not an error. */
public record CopyCallsResult(int added, int skipped) {
}
