package com.fathy.alfred.backend.relive.domain.model;

/**
 * A cycle-wide or step-only ignore rule for comparisons (FR-041b/c). {@code path} is the
 * existing JSON-path syntax used by {@code json-path-input}, or a header name. {@code count}
 * overrides an automatic noise decision.
 */
public record NoiseRule(String part, String path, boolean auto, boolean count) {
}
