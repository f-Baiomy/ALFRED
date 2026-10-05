package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * A project's capture settings. The on/off switch is NOT here - it is the flag file the reverse proxy reads
 * (docs/db-capture.md), so switching takes effect on the next request without the agent asking anyone.
 * {@code rowsPerResult}: 50,000 by default (clarified with the owner), the true total is always kept.
 *
 * <p>{@code passThroughClasses}: classes (or package prefixes) the agent skips when recording which application code
 * issued a statement - a generic DAO every query goes through says nothing ({@code callers}, up to
 * {@code callerFrames} frames). {@code indexInfo}: for a slow statement's table, read its index list once (database
 * metadata, never a query of the user's data). Settings stored before these existed read back with the defaults.
 */
public record DbCaptureSettings(
        int rowsPerResult,
        List<String> beforeImageTables,
        boolean outsideCallCapture,
        Thresholds thresholds,
        List<String> expectedFingerprints,
        List<String> ignorePatterns,
        List<String> passThroughClasses,
        int callerFrames,
        boolean indexInfo
) {
    public static final int DEFAULT_ROWS_PER_RESULT = 50_000;
    public static final int MAX_ROWS_PER_RESULT = 1_000_000;
    public static final int DEFAULT_CALLER_FRAMES = 5;
    public static final int MAX_CALLER_FRAMES = 10;

    public DbCaptureSettings {
        passThroughClasses = passThroughClasses == null ? List.of() : passThroughClasses;
        callerFrames = callerFrames <= 0 ? DEFAULT_CALLER_FRAMES : callerFrames;
    }

    public DbCaptureSettings(int rowsPerResult, List<String> beforeImageTables, boolean outsideCallCapture, Thresholds thresholds,
                             List<String> expectedFingerprints, List<String> ignorePatterns) {
        this(rowsPerResult, beforeImageTables, outsideCallCapture, thresholds, expectedFingerprints, ignorePatterns, List.of(),
                DEFAULT_CALLER_FRAMES, false);
    }

    public static DbCaptureSettings defaults() {
        return new DbCaptureSettings(DEFAULT_ROWS_PER_RESULT, List.of(), true, Thresholds.DEFAULTS, List.of(), List.of("SELECT 1"));
    }
}
