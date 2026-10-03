package com.fathy.alfred.backend.logs.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/** A named explorer state (FR-033). {@code state} is opaque JSON owned by the frontend (pills, range, columns, view, sorts). */
public record SavedView(String id, String sourceId, String name, JsonNode state, String createdAt) {
}
