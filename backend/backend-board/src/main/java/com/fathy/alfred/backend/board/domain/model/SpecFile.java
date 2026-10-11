package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** A .md or .txt spec attached to a cycle. Uploading the same name replaces the content; the replaced one is kept once (Restore previous). */
public record SpecFile(String cycleId, String name, String content, long size, Instant uploadedAt, Actor uploadedBy) {

    public SpecFile(String cycleId, String name, String content, long size, Instant uploadedAt) {
        this(cycleId, name, content, size, uploadedAt, Actor.USER);
    }

    public SpecFileInfo info() {
        return new SpecFileInfo(name, size, uploadedAt, uploadedBy, false);
    }
}
