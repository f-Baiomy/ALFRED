package com.fathy.alfred.backend.relive.domain.model;

import java.util.List;

/** What happens to a call attributed to a run that matches no step (FR-014f). */
public record UnexpectedCallsPolicy(String policy, List<CycleRule> rules, String fallback) {
}
