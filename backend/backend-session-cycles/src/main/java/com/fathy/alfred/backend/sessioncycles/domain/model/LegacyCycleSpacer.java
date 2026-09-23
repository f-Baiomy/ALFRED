package com.fathy.alfred.backend.sessioncycles.domain.model;

/**
 * A spacer still stored in the original "sits BEFORE this call" form (anchored to the call below
 * it, or trailing with both fields null) - read only so it can be converted to {@link CycleSpacer}'s
 * "after this call" form. See LegacySpacerAnchors.
 */
public record LegacyCycleSpacer(String id, String beforeCallId, String anchorTimestamp) {
}
