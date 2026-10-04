package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;

/**
 * A recorded stretch of a live log. While recording ({@code endedAt} null) new lines keep arriving and
 * belong to it; on stop its lines are pinned (kept forever, never trimmed by a size cap).
 *
 * <p>Membership is by arrival time ({@code ingested} between start and end) plus either a filter
 * ({@link Kind#WINDOW}, optional) or one value of one ID field ({@link Kind#ID}: only lines carrying it).
 *
 * @param startedAt  epoch ms, when recording started
 * @param endedAt    epoch ms, or null while recording
 * @param pills      WINDOW: optional filter, the same pills the explorer uses
 * @param idField    ID: the field label (a correlation/session/call ID or a grouping level)
 * @param idValue    ID: the value
 * @param lineCount  lines in the session (final once stopped)
 * @param errorCount lines with level ERROR
 */
public record LogSession(
        String id,
        String sourceId,
        String name,
        String notes,
        Kind kind,
        List<LogQuery.Pill> pills,
        String idField,
        String idValue,
        long startedAt,
        Long endedAt,
        List<Marker> markers,
        long lineCount,
        long errorCount,
        String createdAt
) {

    public enum Kind { WINDOW, ID }

    /** A note on the session's timeline ("clicked Book"), at a wall-clock time. */
    public record Marker(long ts, String text) {
    }

    public boolean recording() {
        return endedAt == null;
    }
}
