package com.fathy.alfred.backend.relive.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * A call that actually reached a real system while a run was active (FR-015b, research D18).
 * Never pruned automatically - see constitution II reasoning in plan.md's Complexity Tracking:
 * each row is a real, already-paid-for supplier answer, and deleting one silently would force a
 * second real call to get it back. Deleted only by the user.
 */
public record LiveCall(
        String id,
        String cycleId,
        String runId,
        String stepKey,
        String reason,
        String loggedCallId,
        JsonNode request,
        JsonNode response,
        int status,
        long durationMs,
        String at
) {
}
