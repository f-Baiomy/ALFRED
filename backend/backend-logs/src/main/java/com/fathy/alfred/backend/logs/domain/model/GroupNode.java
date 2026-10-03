package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;

/**
 * One node of the grouped view. {@code headLine} is the earliest line at exactly this level with
 * these IDs (the parent row); null means no such line exists and the UI shows a placeholder.
 * {@code siblings} are further lines at the same level with the same IDs; {@code skipped} are lines
 * that jump a level (A + C, no B) and hang here with {@code missingLevel} set.
 */
public record GroupNode(
        String path,
        int level,
        String id,
        LogLineSummary headLine,
        List<LogLineSummary> siblings,
        List<LogLineSummary> skipped,
        long childCount,
        long descendantCount,
        long firstTs,
        long lastTs,
        long errorCount,
        double maxDuration
) {
}
