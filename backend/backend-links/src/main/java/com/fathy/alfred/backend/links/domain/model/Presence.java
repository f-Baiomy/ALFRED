package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/** A linked Alfred has one of this Alfred's streamed boards or cycles open right now (D29). */
public record Presence(String linkId, String target, int viewers, Instant since) {
}
