package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;

/**
 * Stats for one field. Numbers/dates: percentiles + a 24-bin distribution; {@code exact} says the
 * percentiles came from the whole filtered set (Exact-search fields) rather than the latest-N window.
 * Text: distinct count + top 10.
 */
public record FieldStats(String label, String type, long values, boolean exact, int window,
                         Double min, Double max, Double p50, Double p95, Double p99,
                         List<Long> distribution, Long distinct, List<FieldValues.ValueCount> top) {
}
