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
 *
 * <p>{@code logLevel} (specs/009-agent-log-capture): the lowest level of log line the agent catches with each call -
 * ERROR (the default), WARN, INFO, DEBUG, TRACE, or APP for whatever the application itself writes. Never below the
 * application's own level: the agent catches after its check and never changes what it logs.
 *
 * <p>{@code attachMode} (docs/server.md "The agent attaches itself"): on a native install the supervisor loads
 * Alfred's agent into the project's application by itself - the JVM on its upstream port. {@link AttachMode#WHEN_ASKED}
 * (the default) does it at start, when calls arrive and no agent reports, and on "Attach now"; {@link AttachMode#AUTOMATIC}
 * also the moment the app's port opens; {@link AttachMode#OFF} never. {@code attachProxy} adds the {@code proxy} feature
 * to that attach (the app's outbound calls go through Alfred's forward proxy); on unless switched off. Settings stored
 * before these existed read back with the defaults; unknown keys (the earlier {@code autoAttach} switch) are ignored.
 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
public record DbCaptureSettings(
        int rowsPerResult,
        List<String> beforeImageTables,
        boolean outsideCallCapture,
        Thresholds thresholds,
        List<String> expectedFingerprints,
        List<String> ignorePatterns,
        List<String> passThroughClasses,
        int callerFrames,
        boolean indexInfo,
        String logLevel,
        RedisSettings redis,
        AttachMode attachMode,
        Boolean attachProxy
) {
    public static final int DEFAULT_ROWS_PER_RESULT = 50_000;
    public static final int MAX_ROWS_PER_RESULT = 1_000_000;
    public static final int DEFAULT_CALLER_FRAMES = 5;
    public static final int MAX_CALLER_FRAMES = 10;
    public static final String DEFAULT_LOG_LEVEL = "ERROR";
    public static final List<String> LOG_LEVELS = List.of("ERROR", "WARN", "INFO", "DEBUG", "TRACE", "APP");

    public DbCaptureSettings {
        passThroughClasses = passThroughClasses == null ? List.of() : passThroughClasses;
        callerFrames = callerFrames <= 0 ? DEFAULT_CALLER_FRAMES : callerFrames;
        logLevel = logLevel == null || logLevel.isBlank() ? DEFAULT_LOG_LEVEL : logLevel.strip().toUpperCase(java.util.Locale.ROOT);
        redis = redis == null ? RedisSettings.defaults() : redis; // settings stored before Redis capture read back with its defaults
        attachMode = attachMode == null ? AttachMode.DEFAULT : attachMode;
        attachProxy = attachProxy == null ? Boolean.TRUE : attachProxy;
    }

    /** Whether the supervisor may attach for this project at all (start, a call without a reporting agent, "Attach now"). */
    public boolean attachesWhenAsked() {
        return attachMode != AttachMode.OFF;
    }

    /** Whether the moment the app's port opens (or its pid changes) is reason enough to attach. */
    public boolean attachesAutomatically() {
        return attachMode == AttachMode.AUTOMATIC;
    }

    public DbCaptureSettings(int rowsPerResult, List<String> beforeImageTables, boolean outsideCallCapture, Thresholds thresholds,
                             List<String> expectedFingerprints, List<String> ignorePatterns, List<String> passThroughClasses,
                             int callerFrames, boolean indexInfo, String logLevel, RedisSettings redis) {
        this(rowsPerResult, beforeImageTables, outsideCallCapture, thresholds, expectedFingerprints, ignorePatterns, passThroughClasses,
                callerFrames, indexInfo, logLevel, redis, null, null);
    }

    /** The features the supervisor loads when it attaches for this project ("proxy" only when {@code attachProxy}). */
    public List<String> attachFeatures() {
        return attachProxy ? List.of("proxy", "db", "logs", "redis") : List.of("db", "logs", "redis");
    }

    public DbCaptureSettings(int rowsPerResult, List<String> beforeImageTables, boolean outsideCallCapture, Thresholds thresholds,
                             List<String> expectedFingerprints, List<String> ignorePatterns, List<String> passThroughClasses,
                             int callerFrames, boolean indexInfo, String logLevel) {
        this(rowsPerResult, beforeImageTables, outsideCallCapture, thresholds, expectedFingerprints, ignorePatterns, passThroughClasses,
                callerFrames, indexInfo, logLevel, null);
    }

    /** The same settings with other Redis settings. */
    public DbCaptureSettings withRedis(RedisSettings redisSettings) {
        return new DbCaptureSettings(rowsPerResult, beforeImageTables, outsideCallCapture, thresholds, expectedFingerprints, ignorePatterns,
                passThroughClasses, callerFrames, indexInfo, logLevel, redisSettings, attachMode, attachProxy);
    }

    public DbCaptureSettings(int rowsPerResult, List<String> beforeImageTables, boolean outsideCallCapture, Thresholds thresholds,
                             List<String> expectedFingerprints, List<String> ignorePatterns, List<String> passThroughClasses,
                             int callerFrames, boolean indexInfo) {
        this(rowsPerResult, beforeImageTables, outsideCallCapture, thresholds, expectedFingerprints, ignorePatterns, passThroughClasses,
                callerFrames, indexInfo, DEFAULT_LOG_LEVEL);
    }

    public DbCaptureSettings(int rowsPerResult, List<String> beforeImageTables, boolean outsideCallCapture, Thresholds thresholds,
                             List<String> expectedFingerprints, List<String> ignorePatterns) {
        this(rowsPerResult, beforeImageTables, outsideCallCapture, thresholds, expectedFingerprints, ignorePatterns, List.of(),
                DEFAULT_CALLER_FRAMES, false, DEFAULT_LOG_LEVEL);
    }

    public static DbCaptureSettings defaults() {
        return new DbCaptureSettings(DEFAULT_ROWS_PER_RESULT, List.of(), true, Thresholds.DEFAULTS, List.of(), List.of("SELECT 1"));
    }
}
