package com.fathy.alfred.backend.relive.domain.model;

/** One pre-run validation result (FR-017). See data-model.md for the {@code code} values. */
public record ValidationFinding(String severity, String code, String stepKey, String message) {
}
