package com.fathy.alfred.backend.relive.domain.model;

import java.util.List;

/** A REPLAY child whose live request differed from its recording (FR-014d). */
public record RequestChangedEntry(List<DifferenceEntry> changes, String decision) {
}
