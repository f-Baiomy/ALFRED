package com.fathy.alfred.backend.logs.domain.model;

/**
 * A comment on a line or on one field of it (FR-035, FR-042). {@code path} is the flattened field
 * path ("" = whole line) - anchoring to the field, not a display line number, is what keeps it
 * on the same field in the Table and JSON views and across folding.
 *
 * @param authorProfileId plain id string of an ALFRED profile; no compile-time link to
 *                        backend-profiles (same as session-cycles' assignedTo)
 */
public record LogComment(String id, String sourceId, String lineId, String path, String text,
                         String authorProfileId, String createdAt) {
}
