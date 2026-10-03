package com.fathy.alfred.backend.logs.domain.model;

/** One grouping level: the ID field (by label) and how that level's nodes are sorted. */
public record GroupLevel(String fieldLabel, GroupSort sort) {
}
