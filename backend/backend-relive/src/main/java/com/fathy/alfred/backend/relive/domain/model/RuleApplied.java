package com.fathy.alfred.backend.relive.domain.model;

import java.util.List;

/** One rule that matched and acted during a step, at a given tier (research D4). */
public record RuleApplied(String ruleId, String name, String tier, List<String> actions) {
}
