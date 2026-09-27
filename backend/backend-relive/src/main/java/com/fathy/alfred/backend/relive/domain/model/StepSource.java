package com.fathy.alfred.backend.relive.domain.model;

/** Where a step's recording came from - "open original" navigates here; it may no longer exist. */
public record StepSource(String callId, String cycleId, String direction) {
}
