package com.fathy.alfred.backend.relive.domain.model;

import java.util.List;

/** Cycle-wide defaults (FR-034 and friends). {@code internalHosts} lists hosts (or suffixes,
 *  e.g. ".internal") that never count as "reaching an external system" (research D14/D15). */
public record ReliveSettings(
        String inboundMode,
        String onFailure,
        String onDifferences,
        String defaultDriver,
        List<String> internalHosts
) {
}
