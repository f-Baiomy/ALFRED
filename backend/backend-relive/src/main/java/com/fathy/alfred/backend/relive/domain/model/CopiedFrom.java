package com.fathy.alfred.backend.relive.domain.model;

/** Where a cycle rule was copied from, when it was copied from an existing global rule. */
public record CopiedFrom(String ruleId, String name, String copiedAt) {
}
