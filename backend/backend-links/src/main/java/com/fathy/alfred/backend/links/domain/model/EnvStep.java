package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/** An environment Alfred's tick on one of the host board's test steps (D36): SEEN or FAILED, like the board's own. */
public record EnvStep(String hostLinkId, String boardId, String stepKey, String state, String note, String actor, Instant at) {
}
