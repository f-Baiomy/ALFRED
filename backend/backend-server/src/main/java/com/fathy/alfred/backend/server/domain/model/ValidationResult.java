package com.fathy.alfred.backend.server.domain.model;

import java.util.Map;

/**
 * One finding about one setting. ERROR blocks a save, WARNING never does (FR-031). {@code detail} carries probe data
 * the UI shows next to the field (used bytes, free disk, the process holding a port, ...).
 */
public record ValidationResult(String key, Level level, String message, Map<String, Object> detail) {

    public enum Level { OK, WARNING, ERROR }

    public ValidationResult {
        detail = detail == null ? Map.of() : Map.copyOf(detail);
    }

    public static ValidationResult error(String key, String message) {
        return new ValidationResult(key, Level.ERROR, message, Map.of());
    }

    public static ValidationResult warning(String key, String message) {
        return new ValidationResult(key, Level.WARNING, message, Map.of());
    }

    public static ValidationResult ok(String key, String message) {
        return new ValidationResult(key, Level.OK, message, Map.of());
    }

    public ValidationResult with(Map<String, Object> moreDetail) {
        return new ValidationResult(key, level, message, moreDetail);
    }
}
