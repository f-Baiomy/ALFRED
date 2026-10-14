package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * An earlier text of a comment or a card's description, kept when it is edited (docs/board.md "Rich text" - edit with a
 * history). {@code owner} is {@code comment:<entry id>} or {@code description:<card id>}; {@code at} is when that text was
 * replaced, {@code actor} who wrote it.
 */
public record TextVersion(String owner, String text, Actor actor, Instant at) {
}
