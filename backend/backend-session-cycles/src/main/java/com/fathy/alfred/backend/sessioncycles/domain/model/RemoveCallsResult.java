package com.fathy.alfred.backend.sessioncycles.domain.model;

/** Result of bulk-removing a set of captured calls from a cycle - notFound counts ids that didn't match any captured call in this cycle, not an error. */
public record RemoveCallsResult(int removed, int notFound) {
}
