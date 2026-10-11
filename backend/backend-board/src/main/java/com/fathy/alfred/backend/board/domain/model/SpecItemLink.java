package com.fathy.alfred.backend.board.domain.model;

/** An Acceptance item of a cycle's spec file that a card is about (specs/015 FR-13). {@code text} is null when the item is gone. */
public record SpecItemLink(String cycleId, String fileName, String itemKey, String text) {
}
