package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** A spec file as listed (no content). */
public record SpecFileInfo(String name, long size, Instant uploadedAt, Actor uploadedBy, boolean hasPrevious) {

    public SpecFileInfo(String name, long size, Instant uploadedAt) {
        this(name, size, uploadedAt, Actor.USER, false);
    }
}
