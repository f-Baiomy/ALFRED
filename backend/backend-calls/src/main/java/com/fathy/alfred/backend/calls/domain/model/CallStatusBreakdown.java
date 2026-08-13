package com.fathy.alfred.backend.calls.domain.model;

/** Counts of logged calls grouped by outcome - drives the Database settings tab's status donut. */
public record CallStatusBreakdown(long total, long ok, long clientError, long serverError) {
}
