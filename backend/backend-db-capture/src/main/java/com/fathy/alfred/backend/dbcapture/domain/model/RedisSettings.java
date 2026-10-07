package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;
import java.util.Locale;

/**
 * A project's Redis capture settings (specs/011-redis-capture FR-011, data-model.md). There is deliberately no setting
 * that limits what is stored (FR-012): every command and reply is kept whole. {@code maskPatterns} only change what is
 * shown (window, exports, Claude) - empty by default (clarification Q3). {@code showValues}: DECODED or RAW - display
 * only. {@code beforeImage}: the agent reads a key's value before a write (its one own command, off by default).
 * {@code slowMillis}: a command slower than this is highlighted and counted in Findings. {@code housekeeping}: also
 * record PING / AUTH / CLIENT / HELLO / SELECT (credentials are never kept whatever this says).
 */
public record RedisSettings(List<String> maskPatterns, String showValues, boolean beforeImage, int slowMillis, boolean housekeeping) {

    public static final int DEFAULT_SLOW_MILLIS = 10;
    public static final int MAX_SLOW_MILLIS = 60_000;
    public static final List<String> SHOW_VALUES = List.of("DECODED", "RAW");

    public RedisSettings {
        maskPatterns = maskPatterns == null ? List.of() : maskPatterns;
        showValues = showValues == null || showValues.isBlank() ? "DECODED" : showValues.strip().toUpperCase(Locale.ROOT);
        slowMillis = slowMillis <= 0 ? DEFAULT_SLOW_MILLIS : slowMillis;
    }

    public static RedisSettings defaults() {
        return new RedisSettings(List.of(), "DECODED", false, DEFAULT_SLOW_MILLIS, false);
    }
}
