package com.fathy.alfred.backend.relive.domain.model;

/** One field-level difference between a recording and what actually happened this run. */
public record DifferenceEntry(String part, String path, String recorded, String actual, String kind, String cause) {
}
