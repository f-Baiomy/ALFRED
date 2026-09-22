package com.fathy.alfred.backend.sessioncycles.domain.model;

/**
 * A user-named divider between captured calls in a session cycle, used to group calls visually
 * (in the call list, and in the .md/.html exports) without any call data of its own. Positioned by
 * anchor rather than by an absolute index: {@code beforeCallId} is the underlying CallRecord's own
 * id - the same id the frontend already keys every call on (detail fetch, comments, exports) -
 * NOT the {@link CapturedCall#id()} wrapper id removeCall/removeCalls use, or null to sit after
 * every call. Anchoring by id rather than a numeric position means a spacer never needs
 * renumbering when calls are added or removed around it - only the one spacer actually anchored to
 * a removed call needs to move (see CycleSpacersStorePort#dropAnchorsTo, and
 * SessionCyclesService#underlyingCallIdOf for the wrapper-id-to-call-id translation removal needs).
 */
public record CycleSpacer(String id, String cycleId, String label, String beforeCallId, String createdAt) {
}
