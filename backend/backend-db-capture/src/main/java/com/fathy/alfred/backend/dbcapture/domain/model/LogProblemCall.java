package com.fathy.alfred.backend.dbcapture.domain.model;

/** One call that had a log problem: how many of its lines, and when the first was written. */
public record LogProblemCall(String callId, long lines, long firstAtMs) {
}
