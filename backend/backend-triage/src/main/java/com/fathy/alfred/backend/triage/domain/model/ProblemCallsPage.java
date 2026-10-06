package com.fathy.alfred.backend.triage.domain.model;

import java.util.List;
import java.util.Map;

/**
 * Problem calls of a set of calls: how many carry each signal (over the whole set, before the filter and the page),
 * how many calls the set has, and one page of the calls the filter keeps - most severe first.
 */
public record ProblemCallsPage(Map<Signal, Integer> counts, int total, int matching, List<ProblemCall> calls, Integer nextOffset) {
}
