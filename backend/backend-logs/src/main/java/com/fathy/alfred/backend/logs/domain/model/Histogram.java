package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;
import java.util.Map;

/** Matches over time, per level, for the explorer's stacked histogram (FR-032). */
public record Histogram(long from, long to, long bucketMs, List<Bucket> buckets) {

    public record Bucket(long from, Map<String, Long> byLevel) {
    }
}
