package com.fathy.alfred.backend.sessioncycles.domain.model;

/**
 * A user-named divider between captured calls in a session cycle, used to group calls visually
 * (in the call list, and in the .md/.html exports) without any call data of its own.
 *
 * <p>Attached to the call directly ABOVE it - the one the user saw right before the gap they added
 * it in: {@code afterCallId} is that call's underlying CallRecord id (the same id the frontend keys
 * every call on - NOT the {@link CapturedCall#id()} wrapper id removeCall/removeCalls use), and
 * {@code anchorTimestamp} that call's own timestamp. Attaching to the call above rather than below
 * is what keeps a spacer put when calls that were hidden while it was added (OPTIONS preflights, a
 * filter) are shown again - they land below it, not between it and the call it was placed after -
 * and it's what lets a spacer added at the end of a still-recording cycle stay there while new
 * calls arrive below it, with nothing to re-pin.
 * <ul>
 *   <li>afterCallId set - sits right after that call;</li>
 *   <li>afterCallId null, anchorTimestamp set - its anchor call was deleted; still placed by time;</li>
 *   <li>both null - sits above every call.</li>
 * </ul>
 * See CycleSpacersStorePort#dropAnchorsTo for deletion, and LegacySpacerAnchors for spacers stored
 * before this model, which anchored to the call below.
 */
public record CycleSpacer(String id, String cycleId, String label, String afterCallId, String createdAt, String anchorTimestamp) {
}
