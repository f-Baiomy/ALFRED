package com.fathy.alfred.backend.board.domain.model;

/** A closed card as Claude reads it before reporting: what the user dismissed, and why. */
public record ClosedReason(int number, String title, String signature, Resolution resolution, String reason) {
}
