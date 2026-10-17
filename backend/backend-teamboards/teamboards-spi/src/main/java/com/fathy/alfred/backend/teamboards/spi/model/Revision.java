package com.fathy.alfred.backend.teamboards.spi.model;

import java.time.Instant;
import java.util.List;

/** One revision of a work item: who changed what, when. */
public record Revision(int rev, String by, Instant at, List<FieldChange> changes) {

    public Revision {
        changes = changes == null ? List.of() : List.copyOf(changes);
    }
}
