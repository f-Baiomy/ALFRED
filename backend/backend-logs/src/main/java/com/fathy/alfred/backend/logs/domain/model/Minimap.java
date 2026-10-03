package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;

/** Where the chosen condition hits across the whole (or evenly sampled) result (FR-027). */
public record Minimap(long total, boolean sampled, List<Long> matches, List<Long> errors, List<Long> warns) {
}
