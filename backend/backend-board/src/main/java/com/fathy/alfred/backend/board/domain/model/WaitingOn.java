package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** A card's waiting state, since when, and who set it (Alfred's own rules set it as the actor whose change caused it). */
public record WaitingOn(Waiting who, Instant since, Actor setBy) {
}
