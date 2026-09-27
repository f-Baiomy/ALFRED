package com.fathy.alfred.backend.relive.domain.model;

/** One checkpoint pause and how it resolved (FR-035a). */
public record PauseEntry(String at, String since, String resolvedAt, String choice, String breakpointId) {
}
