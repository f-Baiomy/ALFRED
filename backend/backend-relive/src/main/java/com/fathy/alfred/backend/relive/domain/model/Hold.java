package com.fathy.alfred.backend.relive.domain.model;

/** Set while a run holds at a failed or differing step (FR-034); the run's status stays RUNNING. */
public record Hold(String stepKey, String reason, String since) {
}
