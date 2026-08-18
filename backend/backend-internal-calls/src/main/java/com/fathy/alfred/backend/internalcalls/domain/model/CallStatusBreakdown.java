package com.fathy.alfred.backend.internalcalls.domain.model;

/** Counts of logged calls grouped by outcome - drives the Database settings tab's status donut. inProgress counts calls still awaiting their upstream response (see CallLifecycleStatus). */
public record CallStatusBreakdown(long total, long ok, long clientError, long serverError, long inProgress) {
}
