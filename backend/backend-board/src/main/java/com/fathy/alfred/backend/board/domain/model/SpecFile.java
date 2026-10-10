package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** A .md or .txt spec attached to a cycle. Uploading the same name replaces the content (no versions). */
public record SpecFile(String cycleId, String name, String content, long size, Instant uploadedAt) {

    public SpecFileInfo info() {
        return new SpecFileInfo(name, size, uploadedAt);
    }
}
