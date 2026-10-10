package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** A spec file as listed (no content). */
public record SpecFileInfo(String name, long size, Instant uploadedAt) {
}
