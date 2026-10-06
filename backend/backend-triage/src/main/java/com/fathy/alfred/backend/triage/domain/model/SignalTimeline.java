package com.fathy.alfred.backend.triage.domain.model;

import java.util.List;
import java.util.Map;

/**
 * Signals per time bucket over a set of calls (by start time; empty buckets left out) and the first moment each signal
 * was seen - to tell a problem that began at a moment from one that was always there.
 */
public record SignalTimeline(int bucketMinutes, List<Bucket> buckets, Map<Signal, Long> firstSeen) {

    public record Bucket(long startMs, int calls, Map<Signal, Integer> counts) {
    }
}
