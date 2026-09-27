package com.fathy.alfred.backend.relive.domain.model;

/** One line of a run's log. See data-model.md Run.log for the {@code kind} values. */
public record LogEntry(String at, String stepKey, String kind, String message) {
}
