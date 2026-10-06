package com.fathy.alfred.backend.logs.domain.model;

/**
 * ALFRED's own copy of a log line linked to a call (specs/008-logs-call-link FR-005a/FR-016): kept for calls a
 * session cycle holds (origin CYCLE) and for imported calls (IMPORT), so they outlive the log source's retention.
 * {@code atMs} is the line's time (epoch ms, UTC); {@code raw} the whole original line.
 */
public record KeptLogLine(
        String callId,
        String sourceId,
        String sourceName,
        String lineId,
        long atMs,
        String level,
        String thread,
        String logger,
        String message,
        String matchedBy,
        String raw,
        Origin origin
) {
    public enum Origin { CYCLE, IMPORT }
}
