package com.fathy.alfred.backend.logs.domain.model;

/** A message template with its count over the current filter (FR-026). */
public record Pattern(long id, String template, long count, String worstLevel) {
}
