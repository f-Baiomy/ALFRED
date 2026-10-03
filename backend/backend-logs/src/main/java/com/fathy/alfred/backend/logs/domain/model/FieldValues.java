package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;
import java.util.Map;

/**
 * Sidebar counts (FR-025 clarification): computed over the latest {@code window} matches, never
 * the whole source, so the request cost is bounded.
 */
public record FieldValues(int window, int sampled, Map<String, Field> fields) {

    public record Field(double presence, List<ValueCount> top) {
    }

    public record ValueCount(String value, long count) {
    }
}
