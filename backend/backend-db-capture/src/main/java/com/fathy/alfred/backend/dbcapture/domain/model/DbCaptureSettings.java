package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * A project's capture settings. The on/off switch is NOT here - it is the flag file the reverse proxy reads
 * (docs/db-capture.md), so switching takes effect on the next request without the agent asking anyone.
 * {@code rowsPerResult}: 50,000 by default (clarified with the owner), the true total is always kept.
 */
public record DbCaptureSettings(
        int rowsPerResult,
        List<String> beforeImageTables,
        boolean outsideCallCapture,
        Thresholds thresholds,
        List<String> expectedFingerprints,
        List<String> ignorePatterns
) {
    public static final int DEFAULT_ROWS_PER_RESULT = 50_000;
    public static final int MAX_ROWS_PER_RESULT = 1_000_000;

    public static DbCaptureSettings defaults() {
        return new DbCaptureSettings(DEFAULT_ROWS_PER_RESULT, List.of(), true, Thresholds.DEFAULTS, List.of(), List.of("SELECT 1"));
    }
}
